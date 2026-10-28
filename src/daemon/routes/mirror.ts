/**
 * 镜像路由：显式 attach 的只读会话镜像（事件不落 workspace_events，仅内存缓冲）。
 *
 * - GET /ws/:id/mirror?after=n —— SSE 纯实时流，不回放：after 只是客户端去重过滤起点
 *   （服务端只推 n > after 的事件，无下界门槛）；唯一硬校验 after > 当前 hwm →
 *   409 {error:"cursor-stale", hwm}。客户端消费序：①先建 SSE 订阅（连接即开始缓冲）
 *   ②逐 attached 会话调 snapshot ③按工作区级 n 去重消费。
 * - GET /ws/:id/mirror/attachable —— 本机可挂载会话列表（各适配器 discover 合并）
 * - POST /ws/:id/mirror/attach —— attach 编排（审计事件 + 本地流 + 成员上行）
 * - DELETE /ws/:id/mirror/:sessionId —— detach（携当前活跃挂载的 attachEventId）
 * - GET /ws/:id/mirror/:sessionId/snapshot —— 该会话当前缓冲全量
 * - POST /ws/:id/mirror/:sessionId/event —— 成员上行通道（房主 hub 分配 n 后扇出）
 *
 * 验签复用 workspace 路由的 X-Amail-Sig 双分支（回环=本机 identity、LAN=peers+成员表）。
 * daemon 进程内状态按 DaemonCore 弱表隔离（同进程多 daemon 测试沙箱互不串扰）。
 */
import { z } from "zod";
import { sendJson, type DaemonCore, type Disposer, type Route, type RouteCtx } from "../router.js";
import { checkRequestSig } from "./workspace.js";
import { getWorkspaceRow, WorkspaceHost, type WorkspaceRow } from "../../workspace/host.js";
import { configureActiveSessions, resetActiveSessions } from "../../workspace/projection-local.js";
import { MirrorHub, MirrorSessions, attachSession, detachSession, attachableList, MirrorError } from "../../mirror/hub.js";
import { claudeCodeAdapter } from "../../mirror/claude-code.js";
import { piAdapter } from "../../mirror/pi.js";
import { opencodeAdapter } from "../../mirror/opencode.js";
import type { MirrorAdapter } from "../../mirror/types.js";
import { RawMirrorEventSchema } from "../../contract/api.js";

/** 测试注入 fixture 根（缺省真实根：~/.claude、~/.pi/agent/sessions、~/.local/share/opencode） */
export function defaultAdapters(env: NodeJS.ProcessEnv = process.env): MirrorAdapter[] {
  return [
    claudeCodeAdapter(env.AMAIL_MIRROR_CC_ROOT),
    piAdapter(env.AMAIL_MIRROR_PI_ROOT),
    opencodeAdapter(env.AMAIL_MIRROR_OC_ROOT),
  ];
}

interface MirrorState {
  hub: MirrorHub;
  sessions: MirrorSessions;
  adapters: MirrorAdapter[];
}

/** 按 daemon 的 db 句柄隔离进程内状态（RouteCtx 是 core 的浅拷贝，不能用对象身份做 key） */
const states = new WeakMap<DaemonCore["db"], MirrorState>();

function stateOf(core: DaemonCore): MirrorState {
  let state = states.get(core.db);
  if (!state) {
    state = { hub: new MirrorHub(core), sessions: new MirrorSessions(), adapters: defaultAdapters() };
    states.set(core.db, state);
  }
  return state;
}

function workspaceOr404(ctx: RouteCtx): WorkspaceRow | undefined {
  const row = getWorkspaceRow(ctx.db, ctx.params.id!);
  if (!row) {
    sendJson(ctx.res, 404, { error: "unknown-workspace" });
    return undefined;
  }
  return row;
}

/** 成员/房主统一验签门（401/403 语义同 workspace 路由） */
function gate(ctx: RouteCtx, row: WorkspaceRow): string | undefined {
  const host = new WorkspaceHost(ctx, row.id);
  const result = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!result.ok) {
    sendJson(ctx.res, result.status ?? 401, { error: result.status === 403 ? "not-a-member" : "unauthorized" });
    return undefined;
  }
  return result.actor;
}

function handleSse(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const { hub } = stateOf(ctx);
  const after = Number.parseInt(ctx.query.get("after") ?? "0", 10) || 0;
  const hwm = hub.hwm(row.id);
  if (after > hwm) {
    sendJson(ctx.res, 409, { error: "cursor-stale", hwm });
    return;
  }
  const res = ctx.res;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  let cursor = after;
  const unsubscribe = hub.subscribe(row.id, (event) => {
    if (event.n > cursor) {
      res.write(`id: ${event.n}\ndata: ${JSON.stringify(event)}\n\n`);
      cursor = event.n;
    }
  });
  ctx.req.on("close", unsubscribe);
}

const AttachReqSchema = z.object({
  sessionId: z.string().min(1),
  cli: z.string().optional(),
});

async function handleAttach(ctx: RouteCtx): Promise<void> {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const parsed = AttachReqSchema.safeParse(ctx.body ?? {});
  if (!parsed.success) {
    sendJson(ctx.res, 400, { error: "invalid-attach" });
    return;
  }
  const { hub, sessions, adapters } = stateOf(ctx);
  try {
    const result = await attachSession(ctx, row, adapters, sessions, parsed.data);
    sendJson(ctx.res, 201, {
      attachEventId: result.attachEventId,
      seq: result.seq,
      hwm: hub.hwm(row.id),
      session: result.session,
    });
  } catch (err) {
    if (err instanceof MirrorError) {
      sendJson(ctx.res, err.code === "unknown-session" ? 404 : 409, { error: err.code });
      return;
    }
    throw err;
  }
}

async function handleDetach(ctx: RouteCtx): Promise<void> {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const { sessions } = stateOf(ctx);
  try {
    const result = await detachSession(ctx, row, sessions, ctx.params.sessionId!);
    sendJson(ctx.res, 200, { detached: true, seq: result.seq });
  } catch (err) {
    if (err instanceof MirrorError) {
      sendJson(ctx.res, 404, { error: err.code });
      return;
    }
    throw err;
  }
}

function handleSnapshot(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const { hub } = stateOf(ctx);
  sendJson(ctx.res, 200, {
    sessionId: ctx.params.sessionId,
    events: hub.snapshot(row.id, ctx.params.sessionId!),
    hwm: hub.hwm(row.id),
  });
}

function handleUplink(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const parsed = RawMirrorEventSchema.safeParse(ctx.body);
  if (!parsed.success || parsed.data.sessionId !== ctx.params.sessionId) {
    sendJson(ctx.res, 400, { error: "invalid-event" });
    return;
  }
  const { hub } = stateOf(ctx);
  const event = hub.ingest(row.id, parsed.data);
  sendJson(ctx.res, 201, { n: event.n });
}

function handleAttachable(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const { adapters } = stateOf(ctx);
  const cwd = ctx.query.get("cwd") ?? undefined;
  sendJson(ctx.res, 200, { workspaceId: row.id, sessions: attachableList(adapters, cwd) });
}

const routes: Route[] = [
  { method: "GET", path: "/ws/:id/mirror", lan: true, handler: handleSse },
  { method: "GET", path: "/ws/:id/mirror/attachable", lan: true, handler: handleAttachable },
  { method: "POST", path: "/ws/:id/mirror/attach", lan: true, handler: handleAttach },
  { method: "DELETE", path: "/ws/:id/mirror/:sessionId", lan: true, handler: handleDetach },
  { method: "GET", path: "/ws/:id/mirror/:sessionId/snapshot", lan: true, handler: handleSnapshot },
  { method: "POST", path: "/ws/:id/mirror/:sessionId/event", lan: true, handler: handleUplink },
];

export default routes;

/**
 * daemon 启动：注入活跃采集流探针（P6 幽灵清理用——否则成员每次补拉会对自己的
 * 挂载产生噪音 detach）；房主重启天然清空全部内存缓冲（镜像数据可 re-attach 重取）。
 * 幽灵清理三触发点中的 daemon 启动扫描由 P6 同步任务恢复（ensureSync 首次成功补拉后
 * ghostCleanup）承接，本路由无需重复编排。
 */
export async function init(core: DaemonCore): Promise<Disposer> {
  const state = stateOf(core);
  configureActiveSessions(() => state.sessions.activeSessionIds());
  return () => {
    // 连接断开自动 detach：停机时按各活跃挂载的 attachEventId best-effort 提交 detach
    const mounts = state.sessions.stopAll();
    for (const mount of mounts) {
      const row = getWorkspaceRow(core.db, mount.workspaceId);
      if (!row) continue;
      void detachSession(core, row, state.sessions, mount.sessionId, mount.attachEventId).catch(() => {});
    }
    resetActiveSessions();
  };
}

import type { Route, RouteCtx, DaemonCore, Disposer } from "../router.js";
import { isLoopbackAddress, sendJson } from "../router.js";
import { z } from "zod";
import { canonicalStringify } from "../../core/crypto.js";
import { getPeerByAddress } from "../../core/peer.js";
import { userAddress } from "../server.js";
import { WorkspaceHost, WorkspaceSubmitError, getWorkspaceRow, type WorkspaceRow } from "../../workspace/host.js";
import { makeEvent } from "../../workspace/events.js";
import { InviteSchema, buildInvite, verifyInviteSig } from "../../workspace/invite.js";
import { deviceVerifyMessage, ensureSync, requestSigMessage, stopSync } from "../../workspace/projection-local.js";

/** X-Amail-Date 时间窗 ±10min */
export const SIG_DATE_WINDOW_MS = 10 * 60_000;

const JoinReqSchema = z.object({
  invite: InviteSchema,
  actor: z.string().min(1),
  sig: z.string().min(1),
});

interface SigGateResult {
  ok: boolean;
  status?: number;
  actor?: string;
}

function header(ctx: RouteCtx, name: string): string | undefined {
  const value = ctx.req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function bodyField(ctx: RouteCtx, field: string): unknown {
  if (ctx.body !== null && typeof ctx.body === "object" && field in ctx.body) {
    return (ctx.body as Record<string, unknown>)[field];
  }
  return undefined;
}

function sendSigError(ctx: RouteCtx, status: number): void {
  sendJson(ctx.res, status, { error: status === 403 ? "not-a-member" : "unauthorized" });
}

/**
 * X-Amail-Sig 双分支验签：
 * - 回环来源：本机 identity 公钥 + 成员表（房主恒为成员，不走 peers）
 * - LAN 来源：验签 + 该设备 ∈ peers 已配对 + ∈ 成员表
 * 无签名/伪造 401，非成员 403。
 */
export function checkRequestSig(ctx: RouteCtx, members: string[], hostAddr: string): SigGateResult {
  const sig = header(ctx, "X-Amail-Sig");
  const date = header(ctx, "X-Amail-Date");
  if (!sig || !date) return { ok: false, status: 401 };
  const t = Date.parse(date);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIG_DATE_WINDOW_MS) {
    return { ok: false, status: 401 };
  }

  const pathname = (ctx.req.url ?? "/").split("?")[0]!;
  const bodyText = ctx.body === undefined ? "" : canonicalStringify(ctx.body);
  const message = requestSigMessage(ctx.req.method ?? "GET", pathname, bodyText);

  const loopback = isLoopbackAddress(ctx.req.socket?.remoteAddress);
  const headerActor = header(ctx, "X-Amail-Actor");

  // 候选公钥：LAN 来源必须命中 peers 已配对设备；回环来源用本机 identity 公钥
  const candidates: string[] = [];
  if (headerActor) {
    const peer = getPeerByAddress(ctx.db, headerActor);
    if (peer) candidates.push(peer.signPubKeyPem);
    else if (!loopback) return { ok: false, status: 401 };
  }
  if (loopback) candidates.push(ctx.identity.signPubPem);
  if (candidates.length === 0) return { ok: false, status: 401 };

  if (!candidates.some((pem) => deviceVerifyMessage(pem, message, sig))) {
    return { ok: false, status: 401 };
  }

  const rawBodyActor = bodyField(ctx, "actor");
  const bodyActor = typeof rawBodyActor === "string" ? rawBodyActor : undefined;
  const actor = headerActor ?? bodyActor ?? hostAddr;
  if (!members.includes(actor)) return { ok: false, status: 403 };
  return { ok: true, actor };
}

function workspaceOr404(ctx: RouteCtx): WorkspaceRow | undefined {
  const row = getWorkspaceRow(ctx.db, ctx.params.id!);
  if (!row) {
    sendJson(ctx.res, 404, { error: "unknown-workspace" });
    return undefined;
  }
  return row;
}

/** 提交通用入口：artifact 拒绝门（上传走 P8 专用端点） */
function handleEventsPost(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const host = new WorkspaceHost(ctx, row.id);
  const gate = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!gate.ok) {
    sendSigError(ctx, gate.status ?? 401);
    return;
  }
  if (bodyField(ctx, "kind") === "artifact") {
    sendJson(ctx.res, 422, { error: "use-upload-endpoint" });
    return;
  }
  try {
    const result = host.submit(ctx.body);
    sendJson(ctx.res, result.duplicate ? 200 : 201, { seq: result.seq, duplicate: result.duplicate });
  } catch (err) {
    if (err instanceof WorkspaceSubmitError) {
      const status = err.code === "not-member" ? 403 : err.code === "bad-sig" ? 401 : 400;
      sendJson(ctx.res, status, { error: err.code });
      return;
    }
    throw err;
  }
}

/** GET events 双形态：Accept SSE → 订阅+回放+游标去重；否则 JSON 补拉 */
function handleEventsGet(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const host = new WorkspaceHost(ctx, row.id);
  const gate = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!gate.ok) {
    sendSigError(ctx, gate.status ?? 401);
    return;
  }
  const since = Number.parseInt(ctx.query.get("since") ?? "0", 10) || 0;

  if ((ctx.req.headers.accept ?? "").includes("text/event-stream")) {
    // 实现序：先建立订阅并缓冲实时事件，再回放 >since 的存量，按游标去重后放行
    const res = ctx.res;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    const buffered: number[] = [];
    let live = false;
    let cursor = since;
    const write = (payload: unknown, seq: number) => {
      if (seq > cursor) {
        res.write(`id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`);
        cursor = seq;
      }
    };
    const unsubscribe = ctx.bus.on((event) => {
      if (event.type !== "ws-event") return;
      const data = event.data as { workspaceId?: string; seq?: number };
      if (data.workspaceId !== row.id || typeof data.seq !== "number") return;
      if (live) write(event.data, data.seq);
      else buffered.push(data.seq);
    });
    ctx.req.on("close", unsubscribe);
    for (const event of host.eventsSince(since)) write({ workspaceId: row.id, seq: event.seq, event }, event.seq);
    live = true;
    for (const seq of buffered.sort((x, y) => x - y)) {
      const event = host.eventsSince(seq - 1).find((e) => e.seq === seq);
      if (event) write({ workspaceId: row.id, seq, event }, seq);
    }
    return;
  }

  const events = host.eventsSince(since);
  sendJson(ctx.res, 200, { workspaceId: row.id, events, lastSeq: host.lastSeq() });
}

function handleStateGet(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const host = new WorkspaceHost(ctx, row.id);
  const gate = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!gate.ok) {
    sendSigError(ctx, gate.status ?? 401);
    return;
  }
  sendJson(ctx.res, 200, { workspaceId: row.id, state: host.state() });
}

/** 房主签发邀请块（仅房主本人） */
function handleInvitePost(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const host = new WorkspaceHost(ctx, row.id);
  const gate = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!gate.ok) {
    sendSigError(ctx, gate.status ?? 401);
    return;
  }
  if (gate.actor !== host.hostAddr) {
    sendJson(ctx.res, 403, { error: "host-only" });
    return;
  }
  sendJson(ctx.res, 200, buildInvite({ dirs: ctx.dirs, identity: ctx.identity }, { id: row.id, name: row.name }));
}

/**
 * 被邀请方准入唯一入口：验邀请块签名 + join 请求设备签名 + 已配对
 * → 房主构造并签署 membership add（actor=房主，payload.member=被邀请方）经 submit 定序。
 * 审计链 = 邀请块签名 + join 请求签名 + 房主署名事件。
 */
function handleJoinPost(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const host = new WorkspaceHost(ctx, row.id);
  const hostAddr = host.hostAddr;

  const sig = header(ctx, "X-Amail-Sig");
  const date = header(ctx, "X-Amail-Date");
  if (!sig || !date) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }
  const t = Date.parse(date);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIG_DATE_WINDOW_MS) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }
  const headerActor = header(ctx, "X-Amail-Actor");
  const peer = headerActor ? getPeerByAddress(ctx.db, headerActor) : undefined;
  if (!headerActor || !peer) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }
  const pathname = (ctx.req.url ?? "/").split("?")[0]!;
  const bodyText = ctx.body === undefined ? "" : canonicalStringify(ctx.body);
  const message = requestSigMessage("POST", pathname, bodyText);
  if (!deviceVerifyMessage(peer.signPubKeyPem, message, sig)) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }

  const parsed = JoinReqSchema.safeParse(ctx.body ?? {});
  if (!parsed.success) {
    sendJson(ctx.res, 400, { error: "invalid-join" });
    return;
  }
  const { invite, actor } = parsed.data;
  if (invite.workspaceId !== row.id || invite.hostAddr !== hostAddr || actor !== headerActor) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }
  // 邀请块签名：房主设备签名
  if (!verifyInviteSig(ctx.identity.signPubPem, invite)) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }
  // join 请求签名：被邀请方设备对 invite.workspaceId‖actor 的签名
  if (!deviceVerifyMessage(peer.signPubKeyPem, `${invite.workspaceId}${actor}`, parsed.data.sig)) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return;
  }

  if (host.state().members.includes(actor)) {
    sendJson(ctx.res, 200, { seq: host.lastSeq(), alreadyMember: true });
    return;
  }
  const event = makeEvent(ctx.identity.signPrivPem, hostAddr, "membership", {
    op: "add",
    member: actor,
  });
  try {
    const result = host.submit(event);
    sendJson(ctx.res, 201, { seq: result.seq, alreadyMember: false });
  } catch (err) {
    if (err instanceof WorkspaceSubmitError) {
      sendJson(ctx.res, 500, { error: err.code });
      return;
    }
    throw err;
  }
}

const routes: Route[] = [
  {
    method: "POST",
    path: "/v1/ws-sync/:id",
    lan: false,
    handler(ctx) {
      const row = workspaceOr404(ctx);
      if (!row) return;
      ensureSync(ctx, row);
      sendJson(ctx.res, 200, { workspaceId: row.id, syncing: true });
    },
  },
  { method: "POST", path: "/ws/:id/events", lan: true, handler: handleEventsPost },
  { method: "GET", path: "/ws/:id/events", lan: true, handler: handleEventsGet },
  { method: "GET", path: "/ws/:id/state", lan: true, handler: handleStateGet },
  { method: "POST", path: "/ws/:id/invite", lan: true, handler: handleInvitePost },
  { method: "POST", path: "/ws/:id/join", lan: true, handler: handleJoinPost },
];

export default routes;

/**
 * daemon 启动时对本机 workspaces 表中 host≠本机的每个工作区 ensureSync 恢复同步；
 * 停机时统一停止。
 */
export async function init(core: DaemonCore): Promise<Disposer> {
  const localAddr = userAddress(core.dirs, core.identity);
  const rows = core.db
    .prepare("SELECT * FROM workspaces WHERE host_addr != ?")
    .all(localAddr) as unknown as WorkspaceRow[];
  for (const row of rows) ensureSync(core, row);
  const mine = new Set(rows.map((r) => r.id));
  return () => {
    for (const id of mine) stopSync(id);
  };
}

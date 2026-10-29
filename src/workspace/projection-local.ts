import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import type { DaemonCore } from "../daemon/router.js";
import { sha256Hex } from "../core/crypto.js";
import { getPeerByAddress } from "../core/peer.js";
import { peerBaseUrl, resolvePeerTarget } from "../core/delivery.js";
import { userAddress } from "../daemon/server.js";
import { canonicalStringify } from "../core/crypto.js";
import { WorkspaceEventSchema } from "../contract/workspace.js";
import { emptyState, foldEvents, makeEvent, type WorkspaceState } from "./events.js";
import type { WorkspaceRow } from "./host.js";

// ---------------------------------------------------------------------------
// X-Amail-Sig 设备请求签名：Ed25519 对 (method + path + sha256(body)) 的签名
// ---------------------------------------------------------------------------

export function deviceSignMessage(privPem: string, message: string): string {
  return edSign(null, Buffer.from(message, "utf8"), createPrivateKey(privPem)).toString("base64");
}

export function deviceVerifyMessage(pubPem: string, message: string, sigB64: string): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(message, "utf8"),
      createPublicKey(pubPem),
      Buffer.from(sigB64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * 签名消息：method + path（不含 query） + sha256(body) hex + X-Amail-Date。
 * Date 入签名，改动时间头即验签失败（±10min 窗另判）。
 */
export function requestSigMessage(
  method: string,
  pathname: string,
  bodySha256: string,
  date: string,
): string {
  return `${method}${pathname}${bodySha256}${date}`;
}

/**
 * 生成签名请求头（body 须与实际发送字节一致：JSON 用 canonicalStringify；
 * 原始字节体（如 artifact 上传）用 bodySha256 直接传实际字节的 sha256 hex）
 */
export function amailSigHeaders(
  privPem: string,
  method: string,
  pathname: string,
  bodyText: string,
  actor?: string,
  bodySha256?: string,
): Record<string, string> {
  const date = new Date().toISOString();
  const headers: Record<string, string> = {
    "X-Amail-Sig": deviceSignMessage(
      privPem,
      requestSigMessage(method, pathname, bodySha256 ?? sha256Hex(bodyText), date),
    ),
    "X-Amail-Date": date,
  };
  if (actor) headers["X-Amail-Actor"] = actor;
  return headers;
}

// ---------------------------------------------------------------------------
// 成员端本地投影
// ---------------------------------------------------------------------------

/** 离线只读：消费已缓存事件折叠（不触发网络） */
export function localState(db: DaemonCore["db"], workspaceId: string): WorkspaceState {
  const rows = db
    .prepare("SELECT event_json FROM workspace_events WHERE workspace_id = ? ORDER BY seq")
    .all(workspaceId) as unknown as { event_json: string }[];
  const events = rows.map((r) => WorkspaceEventSchema.parse(JSON.parse(r.event_json)));
  return foldEvents(events, emptyState());
}

export function maxRemoteSeq(db: DaemonCore["db"], workspaceId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS max FROM workspace_events WHERE workspace_id = ? AND source = 'remote'")
    .get(workspaceId) as { max: number | null };
  return row.max ?? 0;
}

export function maxSeq(db: DaemonCore["db"], workspaceId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS max FROM workspace_events WHERE workspace_id = ?")
    .get(workspaceId) as { max: number | null };
  return row.max ?? 0;
}

function upsertRemoteEvent(core: DaemonCore, workspaceId: string, event: unknown): void {
  const parsed = WorkspaceEventSchema.safeParse(event);
  if (!parsed.success) return;
  core.db
    .prepare(
      `INSERT INTO workspace_events (workspace_id, seq, source, event_json) VALUES (?, ?, 'remote', ?)
       ON CONFLICT(workspace_id, seq) DO NOTHING`,
    )
    .run(workspaceId, parsed.data.seq, canonicalStringify(parsed.data));
  const hasIndex = core.db
    .prepare("SELECT 1 FROM workspace_event_ids WHERE event_id = ?")
    .get(parsed.data.eventId);
  if (!hasIndex) {
    core.db
      .prepare("INSERT INTO workspace_event_ids (event_id, workspace_id, seq) VALUES (?, ?, ?)")
      .run(parsed.data.eventId, workspaceId, parsed.data.seq);
  }
}

/** 解析房主 HTTP 基址（peers 已配对 + mDNS 解析） */
export async function resolveHostBase(db: DaemonCore["db"], hostAddr: string): Promise<string | undefined> {
  const peer = getPeerByAddress(db, hostAddr);
  if (!peer) return undefined;
  const target = await resolvePeerTarget(peer.deviceId);
  return target ? peerBaseUrl(target) : undefined;
}

// ---------------------------------------------------------------------------
// 同步任务生命周期（同步任务只存在于 daemon 进程内）
// ---------------------------------------------------------------------------

interface SyncTask {
  core: DaemonCore;
  workspace: WorkspaceRow;
  stopped: boolean;
  abort: AbortController;
  retries: number;
}

/** workspaceId → 任务（daemon 进程内；不同 db 视为不同 daemon，替换） */
const tasks = new Map<string, SyncTask>();

/** pending 幽灵清理项：来源 attach eventId + sessionId */
const pendingDetaches = new Map<string, Array<{ attachEventId: string; sessionId: string }>>();

/** 活跃采集流探针（P7 注入；默认无活跃流） */
let activeSessionProbe: () => Set<string> = () => new Set();

export function configureActiveSessions(probe: () => Set<string>): void {
  activeSessionProbe = probe;
}

export function resetActiveSessions(): void {
  activeSessionProbe = () => new Set();
}

export function pendingDetachList(workspaceId: string): Array<{ attachEventId: string; sessionId: string }> {
  return pendingDetaches.get(workspaceId) ?? [];
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function myAddr(core: DaemonCore): string {
  return userAddress(core.dirs, core.identity);
}

async function signedGet(core: DaemonCore, base: string, pathAndQuery: string): Promise<Response> {
  // 签名只覆盖 pathname（与 checkRequestSig 一致），query 不参与签名
  const pathname = pathAndQuery.split("?")[0]!;
  const headers = amailSigHeaders(core.identity.signPrivPem, "GET", pathname, "", myAddr(core));
  return fetch(`${base}${pathAndQuery}`, { headers });
}

async function signedPost(core: DaemonCore, base: string, pathname: string, payload: unknown): Promise<Response> {
  const bodyText = canonicalStringify(payload);
  const headers = {
    "content-type": "application/json",
    ...amailSigHeaders(core.identity.signPrivPem, "POST", pathname, bodyText, myAddr(core)),
  };
  return fetch(`${base}${pathname}`, { method: "POST", headers, body: bodyText });
}


async function pullOnce(task: SyncTask): Promise<boolean> {
  const { core, workspace } = task;
  const base = await resolveHostBase(core.db, workspace.host_addr);
  if (!base) return false;
  const pathname = `/ws/${workspace.id}/events`;
  const res = await signedGet(core, base, `${pathname}?since=${maxRemoteSeq(core.db, workspace.id)}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { events?: unknown[] };
  for (const event of body.events ?? []) upsertRemoteEvent(core, workspace.id, event);
  return true;
}

/** 幽灵清理：补回的 attached[] 中 actor=本机且无活跃采集流的残留 → 提交 detach（携来源 attach eventId） */
async function ghostCleanup(task: SyncTask): Promise<void> {
  const { core, workspace } = task;
  const wsId = workspace.id;
  const addr = myAddr(core);
  const state = localState(core.db, wsId);
  const active = activeSessionProbe();
  const pending = pendingDetaches.get(wsId) ?? [];

  // 发现幽灵：actor=本机、无活跃采集流的挂载 → 记 pending（去重）
  for (const att of state.attached) {
    if (att.actor !== addr || active.has(att.sessionId)) continue;
    if (!pending.some((p) => p.attachEventId === att.attachEventId)) {
      pending.push({ attachEventId: att.attachEventId, sessionId: att.sessionId });
    }
  }

  // 重试前核对：sessionId 当前活跃挂载若不存在或已被新挂载取代（attachEventId 不同）→ 撤销该 pending
  const valid = pending.filter((p) => {
    const cur = state.attached.find((a) => a.sessionId === p.sessionId);
    return cur !== undefined && cur.attachEventId === p.attachEventId;
  });
  pendingDetaches.set(wsId, valid);

  // 提交 detach
  const base = await resolveHostBase(core.db, workspace.host_addr);
  if (!base) return;
  const remaining: typeof valid = [];
  for (const p of valid) {
    const detach = makeEvent(core.identity.signPrivPem, addr, "session.detach", {
      sessionId: p.sessionId,
      attachEventId: p.attachEventId,
    });
    const res = await signedPost(core, base, `/ws/${wsId}/events`, detach);
    if (!res.ok) remaining.push(p);
  }
  pendingDetaches.set(wsId, remaining);
}

/** SSE 订阅：按游标去重持续写 workspace_events(source='remote')；流结束/出错时返回 */
async function subscribeSse(task: SyncTask): Promise<void> {
  const { core, workspace } = task;
  const base = await resolveHostBase(core.db, workspace.host_addr);
  if (!base) throw new Error("host unreachable");
  let cursor = maxSeq(core.db, workspace.id);
  const pathname = `/ws/${workspace.id}/events`;
  const headers = {
    accept: "text/event-stream",
    ...amailSigHeaders(core.identity.signPrivPem, "GET", pathname, "", myAddr(core)),
  };
  const res = await fetch(`${base}${pathname}?since=${cursor}`, { headers, signal: task.abort.signal });
  if (!res.ok || !res.body) throw new Error(`SSE handshake ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    if (task.stopped) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6)) as { seq?: number; event?: unknown };
          if (typeof payload.seq === "number" && payload.seq > cursor) {
            upsertRemoteEvent(core, workspace.id, payload.event);
            cursor = payload.seq;
          }
        } catch {
          // 忽略非 JSON 帧
        }
      }
    }
  }
}

async function runSync(task: SyncTask): Promise<void> {
  const initialBackoff = 500;
  let backoff = initialBackoff;
  while (!task.stopped) {
    try {
      // 先补拉再保持 SSE 订阅（同游标去重）
      const pulled = await pullOnce(task);
      if (pulled) {
        task.retries = 0;
        backoff = initialBackoff;
        await ghostCleanup(task);
      }
      await subscribeSse(task);
    } catch {
      // 网络失败 → 指数退避重连并重走补拉
    }
    if (task.stopped) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

/** 幂等：已运行 no-op（不同 db 的任务替换）；否则启动 startSync */
export function ensureSync(core: DaemonCore, workspace: WorkspaceRow): void {
  const existing = tasks.get(workspace.id);
  if (existing && existing.core.db === core.db && !existing.stopped) return;
  if (existing) {
    existing.stopped = true;
    existing.abort.abort();
  }
  const task: SyncTask = { core, workspace, stopped: false, abort: new AbortController(), retries: 0 };
  tasks.set(workspace.id, task);
  void runSync(task).finally(() => {
    if (tasks.get(workspace.id) === task) tasks.delete(workspace.id);
  });
}

export function stopSync(workspaceId: string): void {
  const task = tasks.get(workspaceId);
  if (!task) return;
  task.stopped = true;
  task.abort.abort();
  tasks.delete(workspaceId);
}

export function stopAllSync(): void {
  for (const id of [...tasks.keys()]) stopSync(id);
}

export function isSyncing(workspaceId: string): boolean {
  const task = tasks.get(workspaceId);
  return task !== undefined && !task.stopped;
}

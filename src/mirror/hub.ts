/**
 * 镜像 hub：房主侧序号分配 + 每会话独立内存缓冲 + SSE 扇出；本机挂载簿记与 attach/detach 编排。
 *
 * - 适配器只产 RawMirrorEvent（无序号）；hub.ingest 分配工作区级统一单调 n，
 *   高水位持久化于 meta 表 mirror_hwm:<wsId>（随分配更新，房主重启续号）。
 * - 缓冲：每会话独立最近 500 条，互不挤占，不落库；房主重启清空（可 re-attach 重取）。
 * - attach（房主/成员同路径）：先经 host.submit 提交 session.attach 审计事件
 *   （落 workspace_events、投影 attached[]；attach 成功即按 eventId 规则取代旧挂载），
 *   随后开本地流；成员逐事件 POST /ws/:id/mirror/:sessionId/event 上行房主。
 * - detach(sessionId, attachEventId)：提交 session.detach 审计事件；本地副作用（断流+清缓冲）
 *   只作用于 attachEventId 匹配的挂载代际——不匹配则流与缓冲不动，仅审计事件落库。
 * - 连接断开自动 detach（按当前活跃挂载的 attachEventId）：上行连续失败 ≥3 次触发。
 * - 幽灵清理探针：activeSessionIds() 供 P6 configureActiveSessions 注入。
 */
import type { DaemonCore } from "../daemon/router.js";
import type { MirrorEvent, RawMirrorEvent } from "../contract/api.js";
import { RawMirrorEventSchema } from "../contract/api.js";
import type { WorkspaceRow } from "../workspace/host.js";
import { WorkspaceHost } from "../workspace/host.js";
import { makeEvent } from "../workspace/events.js";
import { canonicalStringify } from "../core/crypto.js";
import { userAddress } from "../daemon/server.js";
import { daemonPort } from "../cli/util.js";
import { amailSigHeaders, resolveHostBase } from "../workspace/projection-local.js";
import type { MirrorAdapter, SessionMeta } from "./types.js";

const BUFFER_CAP = 500;
const UPLINK_MAX_FAILURES = 3;

function hwmKey(workspaceId: string): string {
  return `mirror_hwm:${workspaceId}`;
}

function mountKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

// ---------------------------------------------------------------------------
// 房主侧：序号分配 + 缓冲 + 扇出
// ---------------------------------------------------------------------------

export type MirrorFanout = (event: MirrorEvent) => void;

export class MirrorHub {
  private buffers = new Map<string, Map<string, MirrorEvent[]>>();
  private hwmCache = new Map<string, number>();
  private subs = new Map<string, Set<MirrorFanout>>();

  constructor(private core: DaemonCore) {
    core.bus.on((busEvent) => {
      if (busEvent.type !== "ws-event") return;
      const data = busEvent.data as { workspaceId?: string; event?: { kind?: string; payload?: Record<string, unknown> } };
      const event = data.event;
      if (data.workspaceId === undefined || event?.kind !== "session.detach") return;
      const p = event.payload as { sessionId: string; attachEventId: string };
      this.onDetach(data.workspaceId, p.sessionId, p.attachEventId);
    });
  }

  /** 当前高水位（meta 持久化，重启续号） */
  hwm(workspaceId: string): number {
    const cached = this.hwmCache.get(workspaceId);
    if (cached !== undefined) return cached;
    const row = this.core.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(hwmKey(workspaceId)) as { value: string } | undefined;
    const n = row ? Number(row.value) : 0;
    this.hwmCache.set(workspaceId, n);
    return n;
  }

  /** RawMirrorEvent → 分配 n → MirrorEvent：写缓冲并扇出 */
  ingest(workspaceId: string, raw: unknown): MirrorEvent {
    const parsed = RawMirrorEventSchema.parse(raw);
    const n = this.hwm(workspaceId) + 1;
    this.hwmCache.set(workspaceId, n);
    this.core.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(hwmKey(workspaceId), String(n));
    const event: MirrorEvent = { ...parsed, n };
    let wsBuffers = this.buffers.get(workspaceId);
    if (!wsBuffers) {
      wsBuffers = new Map();
      this.buffers.set(workspaceId, wsBuffers);
    }
    let buf = wsBuffers.get(parsed.sessionId);
    if (!buf) {
      buf = [];
      wsBuffers.set(parsed.sessionId, buf);
    }
    buf.push(event);
    if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
    for (const fn of this.subs.get(workspaceId) ?? []) {
      try {
        fn(event);
      } catch {
        // 单个订阅者异常不影响其余
      }
    }
    return event;
  }

  /** 该会话当前缓冲全量（设计 §17.4 当前快照落点） */
  snapshot(workspaceId: string, sessionId: string): MirrorEvent[] {
    return [...(this.buffers.get(workspaceId)?.get(sessionId) ?? [])];
  }

  subscribe(workspaceId: string, fn: MirrorFanout): () => void {
    let set = this.subs.get(workspaceId);
    if (!set) {
      set = new Set();
      this.subs.set(workspaceId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  /** detach 落库后：仅当代际匹配（或会话已不在投影中）清缓冲；旧代迟到不清新缓冲 */
  private onDetach(workspaceId: string, sessionId: string, attachEventId: string): void {
    const attached = new WorkspaceHost(this.core, workspaceId)
      .state()
      .attached.find((a) => a.sessionId === sessionId);
    if (attached === undefined || attached.attachEventId === attachEventId) {
      this.buffers.get(workspaceId)?.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// 本机挂载簿记（attach 侧）：活跃采集流探针 + 代际匹配断流
// ---------------------------------------------------------------------------

export interface ActiveMount {
  workspaceId: string;
  sessionId: string;
  cli: SessionMeta["cli"];
  attachEventId: string;
  abort: AbortController;
}

export class MirrorSessions {
  private mounts = new Map<string, ActiveMount>();

  mount(mount: ActiveMount): void {
    const key = mountKey(mount.workspaceId, mount.sessionId);
    const existing = this.mounts.get(key);
    if (existing && existing !== mount) existing.abort.abort(); // 新挂载取代旧代
    this.mounts.set(key, mount);
  }

  get(workspaceId: string, sessionId: string): ActiveMount | undefined {
    return this.mounts.get(mountKey(workspaceId, sessionId));
  }

  /** 活跃采集流探针（P6 幽灵清理注入点） */
  activeSessionIds(): Set<string> {
    return new Set([...this.mounts.values()].map((m) => m.sessionId));
  }

  /** 代际匹配才断流；不匹配（已被新挂载取代）→ 不动，返回 false */
  stop(workspaceId: string, sessionId: string, attachEventId: string): boolean {
    const key = mountKey(workspaceId, sessionId);
    const mount = this.mounts.get(key);
    if (!mount || mount.attachEventId !== attachEventId) return false;
    this.mounts.delete(key);
    mount.abort.abort();
    return true;
  }

  stopAll(): ActiveMount[] {
    const all = [...this.mounts.values()];
    this.mounts.clear();
    for (const m of all) m.abort.abort();
    return all;
  }
}

// ---------------------------------------------------------------------------
// attach / detach 编排（发起机本机执行；房主与成员同路径）
// ---------------------------------------------------------------------------

function myAddr(core: DaemonCore): string {
  return userAddress(core.dirs, core.identity);
}

async function hostBase(core: DaemonCore, row: WorkspaceRow): Promise<string> {
  if (row.host_addr === myAddr(core)) {
    return `http://127.0.0.1:${daemonPort(core.dirs)}`;
  }
  const base = await resolveHostBase(core.db, row.host_addr);
  if (!base) throw new Error(`host ${row.host_addr} unreachable — is the daemon running?`);
  return base;
}

interface SubmitOutcome {
  seq: number;
  duplicate: boolean;
}

async function submitToHost(core: DaemonCore, row: WorkspaceRow, event: unknown): Promise<SubmitOutcome> {
  const pathname = `/ws/${row.id}/events`;
  const bodyText = canonicalStringify(event);
  const base = await hostBase(core, row);
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(core.identity.signPrivPem, "POST", pathname, bodyText, myAddr(core)),
    },
    body: bodyText,
  });
  const out = (await res.json().catch(() => ({}))) as { seq?: number; duplicate?: boolean; error?: string };
  if (!res.ok) throw new Error(`submit ${res.status}: ${String(out.error ?? res.statusText)}`);
  return { seq: out.seq ?? 0, duplicate: out.duplicate ?? false };
}

export class MirrorError extends Error {
  constructor(
    public code: "unknown-session" | "not-mounted",
    message: string,
  ) {
    super(message);
  }
}

export interface AttachResult {
  attachEventId: string;
  seq: number;
  session: SessionMeta;
}

/** attach：审计事件 → 开本地流 → 成员逐事件上行房主（房主=回环上行，同经 ingest） */
export async function attachSession(
  core: DaemonCore,
  row: WorkspaceRow,
  adapters: MirrorAdapter[],
  sessions: MirrorSessions,
  opts: { sessionId: string; cli?: string },
): Promise<AttachResult> {
  const found: SessionMeta[] = [];
  for (const adapter of adapters) {
    for (const meta of adapter.discover()) {
      if (meta.sessionId !== opts.sessionId) continue;
      if (opts.cli && meta.cli !== opts.cli) continue;
      found.push(meta);
    }
  }
  const meta = found[0];
  if (!meta) throw new MirrorError("unknown-session", `no attachable session: ${opts.sessionId}`);

  const addr = myAddr(core);
  const event = makeEvent(core.identity.signPrivPem, addr, "session.attach", {
    sessionId: meta.sessionId,
    cli: meta.cli,
    cwd: meta.cwd,
    title: meta.title,
  });
  const { seq } = await submitToHost(core, row, event);

  const adapter = adapters.find((a) => a.id === meta.cli)!;
  const abort = new AbortController();
  sessions.mount({ workspaceId: row.id, sessionId: meta.sessionId, cli: meta.cli, attachEventId: event.eventId, abort });

  const base = await hostBase(core, row);
  const pathname = `/ws/${row.id}/mirror/${meta.sessionId}/event`;
  let failures = 0;
  void (async () => {
    try {
      for await (const raw of adapter.stream(meta.sessionId, abort.signal)) {
        const bodyText = canonicalStringify(raw);
        try {
          const res = await fetch(`${base}${pathname}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...amailSigHeaders(core.identity.signPrivPem, "POST", pathname, bodyText, addr),
            },
            body: bodyText,
          });
          if (!res.ok) throw new Error(`uplink ${res.status}`);
          failures = 0;
        } catch {
          // 连接断开：连续失败达阈值 → 自动 detach（按当前活跃挂载的 attachEventId）
          failures += 1;
          if (failures >= UPLINK_MAX_FAILURES) {
            const mount = sessions.get(row.id, meta.sessionId);
            if (mount && mount.attachEventId === event.eventId) {
              void detachSession(core, row, sessions, meta.sessionId).catch(() => {});
            }
            return;
          }
        }
      }
    } catch {
      // 流异常（文件被删 / db 关闭等）→ 静默结束；挂载由显式 detach 或幽灵清理回收
    }
  })();

  return { attachEventId: event.eventId, seq, session: meta };
}

/** detach：审计事件（携来源 attach eventId）→ 本地代际匹配才断流 */
export async function detachSession(
  core: DaemonCore,
  row: WorkspaceRow,
  sessions: MirrorSessions,
  sessionId: string,
  attachEventId?: string,
): Promise<{ seq: number }> {
  const mount = sessions.get(row.id, sessionId);
  const source = attachEventId ?? mount?.attachEventId;
  if (!source) throw new MirrorError("not-mounted", `session not attached here: ${sessionId}`);
  const event = makeEvent(core.identity.signPrivPem, myAddr(core), "session.detach", {
    sessionId,
    attachEventId: source,
  });
  const { seq } = await submitToHost(core, row, event);
  sessions.stop(row.id, sessionId, source);
  return { seq };
}

/** attachableList：各 adapter.discover 合并 */
export function attachableList(adapters: MirrorAdapter[], cwd?: string): SessionMeta[] {
  return adapters.flatMap((a) => a.discover(cwd));
}

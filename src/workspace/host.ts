import { ulid } from "ulid";
import type { DaemonCore } from "../daemon/router.js";
import type { WorkspaceEvent } from "../contract/workspace.js";
import { WorkspaceEventSchema } from "../contract/workspace.js";
import type { Envelope, SealedBody } from "../contract/envelope.js";
import { canonicalJson } from "../contract/envelope.js";
import { canonicalStringify, sealBody, signCanonical } from "../core/crypto.js";
import { getPeerByAddress } from "../core/peer.js";
import { saveLocalNotice } from "../core/store.js";
import { enqueue } from "../core/outbox.js";
import { loadUserConfig, userAddress } from "../daemon/server.js";
import {
  SubmitEventSchema,
  emptyState,
  foldEvents,
  parseEventJson,
  serializeEvent,
  verifyEventSig,
  type SubmitEvent,
  type WorkspaceState,
} from "./events.js";

export class WorkspaceSubmitError extends Error {
  constructor(
    public code: "not-member" | "bad-sig" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export interface SubmitResult {
  seq: number;
  duplicate: boolean;
  event: WorkspaceEvent;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  project_slug: string;
  host_addr: string;
  created_at: string;
}

export function getWorkspaceRow(db: DaemonCore["db"], workspaceId: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
}

/** CC 通知信封（标准 envelope，无附件无 handoff） */
function buildNoticeEnvelope(
  core: DaemonCore,
  from: string,
  to: string,
  encPubPem: string,
  subject: string,
  body: string,
): Envelope {
  const claim = loadUserConfig(core.dirs);
  const sealed: SealedBody = { body, attachmentIds: [] };
  const unsigned = {
    v: 1 as const,
    id: `msg_${ulid()}`,
    from,
    to,
    subject,
    inReplyTo: null,
    references: [],
    createdAt: new Date().toISOString(),
    claim: { name: claim.name, email: claim.email },
    seal: sealBody(encPubPem, Buffer.from(canonicalJson(sealed), "utf8")),
    attachments: [],
  };
  return { ...unsigned, sig: signCanonical(core.identity.signPrivPem, unsigned) };
}

function ccSubject(workspaceId: string, who: string, content: string): string {
  return `[ws:${workspaceId.slice(0, 8)}] ${who}: ${content.slice(0, 60)}`;
}

function ccBody(who: string, content: string, note: string | undefined, workspaceId: string): string {
  const summary = note ? `${content} — ${note}` : content;
  return `${who}: ${summary}\nworkspaceId: ${workspaceId}`;
}

export interface SubmitOptions {
  /**
   * 外部事务模式：调用方已开启事务；submit 只做落库，不自开/提交事务，也不广播。
   * 调用方 COMMIT 后必须调用 broadcastSubmit(result)。
   */
  transaction?: boolean;
}

/**
 * 房主权威工作区：submit（定序+CC 分派）、eventsSince、state（折叠）。
 * submit 是纯定序入口，不做 kind 限制——artifact 拒绝门在通用路由层。
 */
export class WorkspaceHost {
  readonly hostAddr: string;
  /** 外部事务模式下暂存的 CC 通知（COMMIT 后由 broadcastSubmit 放行） */
  private pendingNotices = new Map<number, { to: string; outboxId: string }[]>();

  constructor(
    private core: DaemonCore,
    public workspaceId: string,
  ) {
    this.hostAddr = userAddress(core.dirs, core.identity);
  }

  lastSeq(): number {
    const row = this.core.db
      .prepare("SELECT MAX(seq) AS max FROM workspace_events WHERE workspace_id = ?")
      .get(this.workspaceId) as { max: number | null };
    return row.max ?? 0;
  }

  eventsSince(seq: number): WorkspaceEvent[] {
    const rows = this.core.db
      .prepare(
        "SELECT event_json FROM workspace_events WHERE workspace_id = ? AND seq > ? ORDER BY seq",
      )
      .all(this.workspaceId, seq) as unknown as { event_json: string }[];
    return rows.map((r) => parseEventJson(r.event_json));
  }

  state(): WorkspaceState {
    const events = this.eventsSince(0);
    return foldEvents(events, emptyState());
  }

  private eventRowByEventId(eventId: string): { seq: number; event_json: string } | undefined {
    return this.core.db
      .prepare(
        `SELECT e.seq AS seq, e.event_json AS event_json FROM workspace_event_ids i
         JOIN workspace_events e ON e.workspace_id = i.workspace_id AND e.seq = i.seq
         WHERE i.event_id = ? AND i.workspace_id = ?`,
      )
      .get(eventId, this.workspaceId) as { seq: number; event_json: string } | undefined;
  }

  /** 提交：eventId 幂等 → 验成员 + 验签 → 分配 seq → 单事务（事件+索引+CC 分派）→ bus 广播 */
  submit(input: unknown, options: SubmitOptions = {}): SubmitResult {
    const ownTransaction = options.transaction !== true;
    const parsed = SubmitEventSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceSubmitError("invalid", `invalid event: ${parsed.error.message}`);
    }
    const ev = parsed.data as SubmitEvent;

    // eventId 幂等：已存在返回原 seq，不重复追加、不重复 CC 通知
    const existing = this.eventRowByEventId(ev.eventId);
    if (existing) {
      return { seq: existing.seq, duplicate: true, event: parseEventJson(existing.event_json) };
    }

    // 验成员
    const members = this.state().members;
    if (!members.includes(ev.actor)) {
      throw new WorkspaceSubmitError("not-member", `actor ${ev.actor} is not a member`);
    }

    // 验签：actor=房主 → 本机 identity 公钥；其他成员 → peers 表公钥
    let pubPem: string | undefined;
    if (ev.actor === this.hostAddr) {
      pubPem = this.core.identity.signPubPem;
    } else {
      pubPem = getPeerByAddress(this.core.db, ev.actor)?.signPubKeyPem;
    }
    if (!pubPem) {
      throw new WorkspaceSubmitError("not-member", `actor ${ev.actor} is not paired`);
    }
    if (!verifyEventSig(pubPem, ev)) {
      throw new WorkspaceSubmitError("bad-sig", `signature check failed for ${ev.actor}`);
    }

    const seq = this.lastSeq() + 1;
    const event = WorkspaceEventSchema.parse({ ...ev, seq }) as WorkspaceEvent;

    const db = this.core.db;
    const notices: { to: string; outboxId: string }[] = [];
    if (ownTransaction) db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO workspace_events (workspace_id, seq, source, event_json) VALUES (?, ?, 'local', ?)",
      ).run(this.workspaceId, seq, serializeEvent(event));
      db.prepare("INSERT INTO workspace_event_ids (event_id, workspace_id, seq) VALUES (?, ?, ?)").run(
        ev.eventId,
        this.workspaceId,
        seq,
      );

      // action 的 cc[] 逐人分派（与事件原子持久化）
      if (event.kind === "action") {
        const subject = ccSubject(this.workspaceId, event.payload.who, event.payload.content);
        const body = ccBody(event.payload.who, event.payload.content, event.payload.note, this.workspaceId);
        for (const cc of event.payload.cc) {
          if (cc === this.hostAddr) {
            // 目标=本机房主 → 本地通知信，不经出箱
            saveLocalNotice(db, this.hostAddr, subject, body);
          } else {
            const peer = getPeerByAddress(db, cc);
            if (!peer) continue; // 未配对的 cc 目标无法送达，跳过
            const envelope = buildNoticeEnvelope(
              this.core,
              this.hostAddr,
              cc,
              peer.encPubKeyPem,
              subject,
              body,
            );
            // 出箱通知：messages(out) 明文副本 + outbox.enqueue，均在同一事务内
            db.prepare(
              `INSERT INTO messages (id, direction, from_addr, to_addr, subject, in_reply_to, thread_root,
                 created_at, received_at, read_at, archived_at, project, body, handoff_json, sig_valid)
               VALUES (?, 'out', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 1)`,
            ).run(
              envelope.id,
              this.hostAddr,
              cc,
              subject,
              envelope.id,
              envelope.createdAt,
              new Date().toISOString(),
              body,
            );
            const outboxId = enqueue(db, { envelope, parts: [] });
            notices.push({ to: cc, outboxId });
          }
        }
      }
      if (ownTransaction) db.exec("COMMIT");
    } catch (err) {
      if (ownTransaction) db.exec("ROLLBACK");
      throw err;
    }

    const result: SubmitResult = { seq, duplicate: false, event };
    this.pendingNotices.set(seq, notices);
    if (ownTransaction) this.broadcastSubmit(result);
    return result;
  }

  /** 外部事务 COMMIT 后放行广播（own-transaction 模式由 submit 内部调用） */
  broadcastSubmit(result: SubmitResult): void {
    const notices = this.pendingNotices.get(result.seq) ?? [];
    this.pendingNotices.delete(result.seq);
    this.core.bus.emit("ws-event", { workspaceId: this.workspaceId, seq: result.seq, event: result.event });
    for (const n of notices) {
      this.core.bus.emit("outbox", { outboxId: n.outboxId, to: n.to });
    }
  }
}

/**
 * 建区单事务：写 workspaces 行 + 房主 membership add 事件（seq=1）——房主天然是首个成员。
 * 返回 workspaceId。
 */
export function createWorkspace(
  core: DaemonCore,
  opts: { name: string; projectSlug: string; id?: string },
): string {
  const workspaceId = opts.id ?? `ws_${ulid()}`;
  const hostAddr = userAddress(core.dirs, core.identity);
  const event = {
    eventId: `evt_${ulid()}`,
    actor: hostAddr,
    kind: "membership" as const,
    payload: { op: "add" as const, member: hostAddr },
    at: new Date().toISOString(),
  };
  const sig = signCanonical(core.identity.signPrivPem, event);
  const full = WorkspaceEventSchema.parse({ ...event, sig, seq: 1 }) as WorkspaceEvent;

  const db = core.db;
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO workspaces (id, name, project_slug, host_addr, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, opts.name, opts.projectSlug, hostAddr, full.at);
    db.prepare(
      "INSERT INTO workspace_events (workspace_id, seq, source, event_json) VALUES (?, 1, 'local', ?)",
    ).run(workspaceId, serializeEvent(full));
    db.prepare("INSERT INTO workspace_event_ids (event_id, workspace_id, seq) VALUES (?, ?, 1)").run(
      full.eventId,
      workspaceId,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  core.bus.emit("ws-event", { workspaceId, seq: 1, event: full });
  return workspaceId;
}

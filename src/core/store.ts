import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ulid } from "ulid";
import type { Envelope } from "../contract/envelope.js";
import type { DeliverReq } from "../contract/api.js";
import type { InboxQuery } from "../contract/api.js";
import { enqueue } from "./outbox.js";

export interface OpenedInbound {
  /** 解封后的正文 */
  body: string;
  /** 解封后的 handoff（JSON 字符串） */
  handoffJson?: string;
  /** 解封后的附件：blob 已落地的 id + 路径 */
  attachments: Array<{ id: string; blobPath: string }>;
}

export interface LocalCopy {
  body: string;
  handoffJson?: string;
}

export interface MessageRow {
  id: string;
  direction: "in" | "out";
  from_addr: string;
  to_addr: string;
  subject: string;
  in_reply_to: string | null;
  thread_root: string;
  created_at: string;
  received_at: string | null;
  read_at: string | null;
  archived_at: string | null;
  project: string | null;
  body: string;
  handoff_json: string | null;
  sig_valid: number | null;
}

function threadRootOf(db: DatabaseSync, envelope: Pick<Envelope, "id" | "inReplyTo">): string {
  if (!envelope.inReplyTo) return envelope.id;
  const parent = db.prepare("SELECT thread_root FROM messages WHERE id = ?").get(envelope.inReplyTo) as
    | { thread_root: string }
    | undefined;
  return parent?.thread_root ?? envelope.id;
}

function insertMessage(
  db: DatabaseSync,
  row: Omit<MessageRow, "thread_root">,
): string {
  const thread_root = threadRootOf(db, { id: row.id, inReplyTo: row.in_reply_to });
  db.prepare(
    `INSERT INTO messages (id, direction, from_addr, to_addr, subject, in_reply_to, thread_root,
       created_at, received_at, read_at, archived_at, project, body, handoff_json, sig_valid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.direction,
    row.from_addr,
    row.to_addr,
    row.subject,
    row.in_reply_to,
    thread_root,
    row.created_at,
    row.received_at,
    row.read_at,
    row.archived_at,
    row.project,
    row.body,
    row.handoff_json,
    row.sig_valid,
  );
  return thread_root;
}

function insertAttachments(
  db: DatabaseSync,
  envelope: Envelope,
  attachments: OpenedInbound["attachments"],
): void {
  const metaById = new Map(envelope.attachments.map((a) => [a.id, a]));
  const stmt = db.prepare(
    `INSERT INTO attachments (id, message_id, blob_path, name, mime, size, sha256, note, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const att of attachments) {
    const meta = metaById.get(att.id);
    stmt.run(att.id, envelope.id, att.blobPath, meta?.name ?? att.id, null, meta?.size ?? 0, meta?.sha256 ?? "", null, "[]");
  }
}

/**
 * 收件落库：opened = P4 deliver 解封后的结果（正文/handoff/blob 路径显式传入）。
 * 单事务：message + attachments + fts（触发器同步）。
 */
export function saveInbound(
  db: DatabaseSync,
  envelope: Envelope,
  opened: OpenedInbound,
  opts: { sigValid: boolean },
): void {
  db.exec("BEGIN");
  try {
    insertMessage(db, {
      id: envelope.id,
      direction: "in",
      from_addr: envelope.from,
      to_addr: envelope.to,
      subject: envelope.subject,
      in_reply_to: envelope.inReplyTo,
      created_at: envelope.createdAt,
      received_at: new Date().toISOString(),
      read_at: null,
      archived_at: null,
      project: null,
      body: opened.body,
      handoff_json: opened.handoffJson ?? null,
      sig_valid: opts.sigValid ? 1 : 0,
    });
    insertAttachments(db, envelope, opened.attachments);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * 发件落库：messages(out，正文取 localCopy 明文) + outbox.enqueue 原子落库。
 * 返回 { messageId, outboxId }。
 */
export function saveOutbound(
  db: DatabaseSync,
  deliverReq: DeliverReq,
  localCopy: LocalCopy,
): { messageId: string; outboxId: string } {
  const envelope = deliverReq.envelope;
  let outboxId = "";
  db.exec("BEGIN");
  try {
    insertMessage(db, {
      id: envelope.id,
      direction: "out",
      from_addr: envelope.from,
      to_addr: envelope.to,
      subject: envelope.subject,
      in_reply_to: envelope.inReplyTo,
      created_at: envelope.createdAt,
      received_at: new Date().toISOString(),
      read_at: null,
      archived_at: null,
      project: null,
      body: localCopy.body,
      handoff_json: localCopy.handoffJson ?? null,
      sig_valid: 1,
    });
    for (const part of deliverReq.parts) {
      const meta = envelope.attachments.find((a) => a.id === part.id);
      db.prepare(
        `INSERT INTO attachments (id, message_id, blob_path, name, mime, size, sha256, note, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(part.id, envelope.id, "", meta?.name ?? part.id, null, meta?.size ?? 0, meta?.sha256 ?? "", null, "[]");
    }
    outboxId = enqueue(db, deliverReq);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { messageId: envelope.id, outboxId };
}

/** 收件箱列表：默认未归档；project 过滤；unread 只看未读；all 含归档 */
export function listInbox(db: DatabaseSync, query: InboxQuery = {}): MessageRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (!query.all) where.push("archived_at IS NULL");
  if (query.project) {
    where.push("project = ?");
    params.push(query.project);
  }
  if (query.unread) where.push("read_at IS NULL");
  const sql = `SELECT * FROM messages WHERE direction = 'in' ${
    where.length ? `AND ${where.join(" AND ")}` : ""
  } ORDER BY created_at DESC`;
  return db.prepare(sql).all(...params) as unknown as MessageRow[];
}

export function get(db: DatabaseSync, id: string): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
}

/** 标已读：返回是否发生 空→已读 转移（供回执首次门槛） */
export function markRead(db: DatabaseSync, id: string): boolean {
  const res = db
    .prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), id);
  return res.changes > 0;
}

/** 归档到项目：标记 archived_at + project */
export function markArchived(db: DatabaseSync, id: string, project: string): void {
  db.prepare("UPDATE messages SET archived_at = ?, project = ? WHERE id = ?").run(
    new Date().toISOString(),
    project,
    id,
  );
}

/** 本机通知信：direction='in'、不经出箱（CC 房主时用）。返回信件 id。 */
export function saveLocalNotice(
  db: DatabaseSync,
  from: string,
  subject: string,
  body: string,
): string {
  const id = `msg_${ulid()}`;
  insertMessage(db, {
    id,
    direction: "in",
    from_addr: from,
    to_addr: from,
    subject,
    in_reply_to: null,
    created_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    read_at: null,
    archived_at: null,
    project: null,
    body,
    handoff_json: null,
    sig_valid: 1,
  });
  return id;
}

/** 检索：≥3 字走 FTS trigram，否则 LIKE 兜底 */
export function search(db: DatabaseSync, q: string): MessageRow[] {
  if (q.length >= 3) {
    const needle = q.replace(/"/g, '""');
    return db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? ORDER BY rank`,
      )
      .all(`"${needle}"`) as unknown as MessageRow[];
  }
  const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
  return db
    .prepare("SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY created_at DESC")
    .all(like) as unknown as MessageRow[];
}

/** 线程视图：按 thread_root 聚合 */
export function threadOf(db: DatabaseSync, id: string): MessageRow[] {
  const msg = get(db, id);
  if (!msg) return [];
  return db
    .prepare("SELECT * FROM messages WHERE thread_root = ? ORDER BY created_at")
    .all(msg.thread_root) as unknown as MessageRow[];
}

/** 记回执（幂等） */
export function recordReceipt(db: DatabaseSync, messageId: string, kind: "delivered" | "read"): void {
  db.prepare(
    "INSERT INTO receipts (message_id, kind, at) VALUES (?, ?, ?) ON CONFLICT(message_id, kind) DO NOTHING",
  ).run(messageId, kind, new Date().toISOString());
}

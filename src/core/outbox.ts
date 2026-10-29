import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type { DeliverReq } from "../contract/api.js";
import { DeliverReqSchema } from "../contract/api.js";
import { canonicalStringify } from "./crypto.js";

export type OutboxState = "queued" | "delivered" | "expired";

export interface OutboxRow {
  id: string;
  payload_json: string;
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
  expires_at: number;
  state: OutboxState;
}

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 3_600_000;
export const EXPIRE_AFTER_MS = 72 * 3_600_000;

/** 30s 起 ×2 封顶 1h */
export function backoffFor(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
}

/** 入出箱（queued），payload 为 DeliverReq 完整序列化 */
export function enqueue(db: DatabaseSync, req: DeliverReq, now = Date.now()): string {
  const parsed = DeliverReqSchema.parse(req);
  const id = `out_${ulid()}`;
  db.prepare(
    `INSERT INTO outbox (id, payload_json, attempts, next_retry_at, last_error, created_at, expires_at, state)
     VALUES (?, ?, 0, ?, NULL, ?, ?, 'queued')`,
  ).run(id, canonicalStringify(parsed), now, now, now + EXPIRE_AFTER_MS);
  return id;
}

/** 到期待投递（queued 且 next_retry_at ≤ now） */
export function due(db: DatabaseSync, now = Date.now()): OutboxRow[] {
  return db
    .prepare("SELECT * FROM outbox WHERE state = 'queued' AND next_retry_at <= ? ORDER BY created_at")
    .all(now) as unknown as OutboxRow[];
}

export function get(db: DatabaseSync, id: string): OutboxRow | undefined {
  return db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
}

/** 记一次失败投递：attempts+1，按退避计算下次重试（30s 起 ×2 封顶 1h） */
export function markAttempt(
  db: DatabaseSync,
  id: string,
  err: string,
  nextRetry: number,
): void {
  db.prepare(
    "UPDATE outbox SET attempts = attempts + 1, next_retry_at = ?, last_error = ? WHERE id = ?",
  ).run(nextRetry, err, id);
}

/** 从 attempts 推导并记录失败（供无显式 nextRetry 的调用方） */
export function markAttemptWithBackoff(db: DatabaseSync, id: string, err: string, now = Date.now()): number {
  const row = get(db, id);
  const nextRetry = now + backoffFor((row?.attempts ?? 0) + 1);
  markAttempt(db, id, err, nextRetry);
  return nextRetry;
}

export function markDelivered(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE outbox SET state = 'delivered' WHERE id = ?").run(id);
}

/** 超过 72h 未送达的 queued 项转 expired，返回过期列表 */
export function expireDue(db: DatabaseSync, now = Date.now(), afterMs = EXPIRE_AFTER_MS): OutboxRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM outbox WHERE state = 'queued' AND created_at + ? <= ? ORDER BY created_at",
    )
    .all(afterMs, now) as unknown as OutboxRow[];
  const update = db.prepare("UPDATE outbox SET state = 'expired' WHERE id = ?");
  for (const row of rows) update.run(row.id);
  return rows;
}

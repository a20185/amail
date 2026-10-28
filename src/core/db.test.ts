import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, openStore, SCHEMA_VERSION } from "./db.js";

function tmpDb(): { path: string; db: DatabaseSync } {
  const path = join(mkdtempSync(join(tmpdir(), "amail-db-")), "store.db");
  return { path, db: openStore(path) };
}

describe("openStore", () => {
  it("开启 WAL 与 foreign_keys ON", () => {
    const { db } = tmpDb();
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    db.close();
  });
});

describe("migrate", () => {
  it("建全所有表（messages/attachments/receipts/peers/outbox/workspace_events/workspace_event_ids/workspaces/meta）", () => {
    const { db } = tmpDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      "messages",
      "attachments",
      "receipts",
      "peers",
      "outbox",
      "workspace_events",
      "workspace_event_ids",
      "workspaces",
      "meta",
      "messages_fts",
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("schema_version=1 写入 meta", () => {
    const { db } = tmpDb();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "1" });
    expect(SCHEMA_VERSION).toBe(1);
    db.close();
  });

  it("迁移幂等：跑两次无副作用且版本不变", () => {
    const { db } = tmpDb();
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "1" });
    db.close();
  });

  it("outbox.state 约束 queued/delivered/expired", () => {
    const { db } = tmpDb();
    db.prepare(
      `INSERT INTO outbox (id, payload_json, attempts, next_retry_at, created_at, expires_at, state)
       VALUES ('o1', '{}', 0, 0, 0, 0, 'queued')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO outbox (id, payload_json, attempts, next_retry_at, created_at, expires_at, state)
         VALUES ('o2', '{}', 0, 0, 0, 0, 'bogus')`,
      ).run(),
    ).toThrow();
    db.close();
  });

  it("attachments 对 messages 有外键级联删除", () => {
    const { db } = tmpDb();
    db.prepare(
      `INSERT INTO messages (id, direction, from_addr, to_addr, subject, thread_root, created_at, body)
       VALUES ('m1', 'in', 'a@b', 'c@d', 's', 'm1', '2026-01-01T00:00:00Z', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, blob_path, name, size, sha256)
       VALUES ('a1', 'm1', '/tmp/a1', 'f', 1, '${"a".repeat(64)}')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO attachments (id, message_id, blob_path, name, size, sha256)
         VALUES ('a2', 'nope', '/tmp/a2', 'f', 1, '${"a".repeat(64)}')`,
      ).run(),
    ).toThrow();
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM attachments").get()).toEqual({ c: 0 });
    db.close();
  });
});

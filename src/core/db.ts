import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  in_reply_to TEXT,
  thread_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT,
  read_at TEXT,
  archived_at TEXT,
  project TEXT,
  body TEXT NOT NULL,
  handoff_json TEXT,
  sig_valid INTEGER
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  blob_path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delivered', 'read')),
  at TEXT NOT NULL,
  PRIMARY KEY (message_id, kind)
);

CREATE TABLE IF NOT EXISTS peers (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  user TEXT NOT NULL,
  device TEXT NOT NULL,
  claim_name TEXT NOT NULL,
  claim_email TEXT NOT NULL,
  sign_pub_pem TEXT NOT NULL,
  enc_pub_pem TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'delivered', 'expired'))
);

CREATE TABLE IF NOT EXISTS workspace_events (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'remote')),
  event_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);

CREATE TABLE IF NOT EXISTS workspace_event_ids (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  host_addr TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  tokenize = 'trigram',
  content = 'messages',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

export function openStore(storePath: string): DatabaseSync {
  const db = new DatabaseSync(storePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** 幂等迁移：单版本 schema_version=1，重复执行无副作用 */
export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`store schema v${current} newer than supported v${SCHEMA_VERSION}`);
  }
  if (current < SCHEMA_VERSION) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  }
}

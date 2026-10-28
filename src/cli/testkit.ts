import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { DatabaseSync } from "node:sqlite";
import { resolveDirs, type Dirs } from "../core/paths.js";
import { startDaemon, type DaemonHandle } from "../daemon/server.js";
import { saveInbound } from "../core/store.js";
import type { Envelope } from "../contract/envelope.js";

/** AMAIL_HOME 沙箱 env（HOME 同箱，git config --global 隔离） */
export function sandboxEnv(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "amail-cli-"));
  return { home, env: { ...process.env, AMAIL_HOME: home, HOME: home } };
}

/** 写 config.json（daemon 桩端口） */
export function writeConfig(home: string, port: number): Dirs {
  const dirs = resolveDirs({ AMAIL_HOME: home });
  writeFileSync(
    join(dirs.configDir, "config.json"),
    JSON.stringify({ version: 1, name: "User Name", email: "user@example.com", port, notify: true }),
    "utf8",
  );
  return dirs;
}

/** P2 startDaemon 随机端口测试桩 + config.json 同步 */
export async function startStub(home: string): Promise<{ handle: DaemonHandle; dirs: Dirs }> {
  const dirs = resolveDirs({ AMAIL_HOME: home });
  const handle = await startDaemon({ port: 0, dirs });
  writeConfig(home, handle.port);
  return { handle, dirs };
}

/** 最小合法信封（saveInbound 直接入库，绕过网络面） */
export function seedEnvelope(over: Partial<Envelope> = {}): Envelope {
  const base = {
    v: 1 as const,
    id: `msg_${ulid()}`,
    from: "alice@laptop",
    to: "user@device",
    subject: "hello world",
    inReplyTo: null,
    references: [] as string[],
    createdAt: new Date().toISOString(),
    claim: { name: "Alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm" as const, epk: "", iv: "", body: "" },
    attachments: [],
    sig: "test",
  };
  return { ...base, ...over };
}

export function seedInbound(
  db: DatabaseSync,
  over: {
    envelope?: Partial<Envelope>;
    body?: string;
    handoffJson?: string;
    attachments?: Array<{ id: string; blobPath: string }>;
  } = {},
): string {
  const envelope = seedEnvelope(over.envelope);
  saveInbound(
    db,
    envelope,
    {
      body: over.body ?? "plain body",
      handoffJson: over.handoffJson,
      attachments: over.attachments ?? [],
    },
    { sigValid: true },
  );
  return envelope.id;
}

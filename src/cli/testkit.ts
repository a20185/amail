import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { DatabaseSync } from "node:sqlite";
import { resolveDirs, type Dirs } from "../core/paths.js";
import { startDaemon, type DaemonHandle } from "../daemon/server.js";
import { fakeMdns } from "../daemon/e2e-kit.js";
import { saveInbound } from "../core/store.js";
import { sealBody, sha256Hex, signCanonical } from "../core/crypto.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../core/identity.js";
import type { Envelope } from "../contract/envelope.js";
import type { DeliverReq } from "../contract/api.js";


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
  const handle = await startDaemon({ port: 0, dirs, mdns: fakeMdns });
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

/**
 * 构造 A→B 的合法 DeliverReq（正文+可选附件 parts，B 身份加密、A 身份签名）。
 * over 可覆盖 id/createdAt/inReplyTo 与附件声明（size 声明与字节可故意不符）。
 */
export function buildDeliverReq(
  from: Pick<DeviceIdentityFull, "deviceId" | "deviceName" | "signPrivPem">,
  to: Pick<DeviceIdentityFull, "encPubPem">,
  over: {
    fromAddr?: string;
    toAddr?: string;
    id?: string;
    createdAt?: string;
    subject?: string;
    inReplyTo?: string | null;
    attachments?: Array<{ id: string; name: string; bytes: Buffer; declaredSize?: number }>;
  } = {},
): DeliverReq {
  const fromAddr = over.fromAddr ?? `${from.deviceName}-user@${from.deviceName}`;
  const toAddr = over.toAddr ?? `to@device`;
  const attachments = (over.attachments ?? []).map((att) => ({
    id: att.id,
    name: att.name,
    sha256: sha256Hex(att.bytes),
    size: att.declaredSize ?? att.bytes.length,
  }));
  const sealed = sealBody(to.encPubPem, Buffer.from(JSON.stringify({ body: "e2e body", attachmentIds: attachments.map((a) => a.id) }), "utf8"));
  const unsigned = {
    v: 1 as const,
    id: over.id ?? `msg_${ulid()}`,
    from: fromAddr,
    to: toAddr,
    subject: over.subject ?? "e2e subject",
    inReplyTo: over.inReplyTo ?? null,
    references: over.inReplyTo ? [over.inReplyTo] : [],
    createdAt: over.createdAt ?? new Date().toISOString(),
    claim: { name: fromAddr.split("@")[0]!, email: "from@example.com" },
    seal: sealed,
    attachments,
  };
  return {
    envelope: { ...unsigned, sig: signCanonical(from.signPrivPem, unsigned) },
    parts: (over.attachments ?? []).map((att, i) => ({
      id: attachments[i]!.id,
      seal: sealBody(to.encPubPem, att.bytes),
    })),
  };
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs } from "../core/paths.js";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { savePeer } from "../core/peer.js";
import { listInbox } from "../core/store.js";
import { canonicalStringify, signCanonical } from "../core/crypto.js";
import { EventBus } from "../daemon/sse.js";
import type { DaemonCore } from "../daemon/router.js";
import { WorkspaceHost, WorkspaceSubmitError, createWorkspace } from "./host.js";
import { makeEvent, eventSigningPayload } from "./events.js";

function sandbox(tag: string): DaemonCore {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), tag)) });
  return {
    db: openStore(dirs.storePath),
    dirs,
    identity: loadOrCreateIdentity(dirs),
    bus: new EventBus(),
  };
}

function keypair(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const cores: DaemonCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.db.close();
});

function makeCore(tag: string): DaemonCore {
  const core = sandbox(tag);
  cores.push(core);
  return core;
}

describe("WorkspaceHost", () => {
  it("createWorkspace 单事务：行 + 房主 membership add seq=1；房主恒为成员", () => {
    const core = makeCore("host-create-");
    const id = createWorkspace(core, { name: "W", projectSlug: "p" });
    const host = new WorkspaceHost(core, id);
    expect(host.lastSeq()).toBe(1);
    expect(host.state().members).toEqual([host.hostAddr]);
    expect(core.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id)).toBeDefined();
  });

  it("定序连续无洞；eventId 幂等返回原 seq 不重复追加", () => {
    const core = makeCore("host-seq-");
    const id = createWorkspace(core, { name: "W", projectSlug: "p" });
    const host = new WorkspaceHost(core, id);
    const e1 = makeEvent(core.identity.signPrivPem, host.hostAddr, "action", { who: host.hostAddr, content: "a", cc: [] });
    const e2 = makeEvent(core.identity.signPrivPem, host.hostAddr, "action", { who: host.hostAddr, content: "b", cc: [] });
    const r1 = host.submit(e1);
    const r2 = host.submit(e2);
    expect([r1.seq, r2.seq]).toEqual([2, 3]);
    // 重复提交同一 eventId → 原 seq，duplicate
    const dup = host.submit(e1);
    expect(dup).toMatchObject({ seq: 2, duplicate: true });
    expect(host.lastSeq()).toBe(3);
    expect(host.eventsSince(0).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("非成员 actor → not-member；成员但伪造签名 → bad-sig", () => {
    const core = makeCore("host-authz-");
    const id = createWorkspace(core, { name: "W", projectSlug: "p" });
    const host = new WorkspaceHost(core, id);

    const outsider = makeEvent(core.identity.signPrivPem, "mallory@evil", "action", { who: "mallory@evil", content: "x", cc: [] });
    expect(() => host.submit(outsider)).toThrow(WorkspaceSubmitError);
    try {
      host.submit(outsider);
    } catch (err) {
      expect((err as WorkspaceSubmitError).code).toBe("not-member");
    }

    // 未配对成员（无法验签）
    const unpaired = makeEvent(core.identity.signPrivPem, "bob@pc", "action", { who: "bob@pc", content: "x", cc: [] });
    try {
      host.submit(unpaired);
      expect.unreachable();
    } catch (err) {
      expect((err as WorkspaceSubmitError).code).toBe("not-member");
    }

    // 已配对成员 + 正确签名 → 通过
    const bobKeys = keypair();
    const x25519 = generateKeyPairSync("x25519");
    savePeer(core.db, {
      deviceId: "f".repeat(16),
      deviceName: "pc",
      user: "bob",
      device: "pc",
      claim: { name: "Bob", email: "bob@x.com" },
      signPubKeyPem: bobKeys.pub,
      encPubKeyPem: x25519.publicKey.export({ type: "spki", format: "pem" }).toString(),
      pairedAt: new Date().toISOString(),
      revokedAt: null,
    });
    core.db.exec("BEGIN");
    core.db
      .prepare("INSERT INTO workspace_events (workspace_id, seq, source, event_json) VALUES (?, 2, 'local', ?)")
      .run(id, canonicalStringify({
        seq: 2,
        eventId: "we_01HGV2KP5Z4W7R8X9Y0ZABCD1F",
        actor: host.hostAddr,
        kind: "membership",
        payload: { op: "add", member: "bob@pc" },
        at: new Date().toISOString(),
        sig: signCanonical(core.identity.signPrivPem, eventSigningPayload({
          eventId: "we_01HGV2KP5Z4W7R8X9Y0ZABCD1F",
          actor: host.hostAddr,
          kind: "membership" as const,
          payload: { op: "add" as const, member: "bob@pc" },
          at: new Date().toISOString(),
        })),
      }));
    core.db.exec("COMMIT");

    const good = makeEvent(bobKeys.priv, "bob@pc", "action", { who: "bob@pc", content: "hi", cc: [] });
    expect(host.submit(good).seq).toBe(3);

    // 伪造签名（用别人密钥签）
    const evilKeys = keypair();
    const forged = makeEvent(evilKeys.priv, "bob@pc", "action", { who: "bob@pc", content: "hi", cc: [] });
    try {
      host.submit(forged);
      expect.unreachable();
    } catch (err) {
      expect((err as WorkspaceSubmitError).code).toBe("bad-sig");
    }
  });

  it("cc 分派：目标=房主 → 本地通知信；目标=成员 → 出箱 enqueue（原子）", () => {
    const core = makeCore("host-cc-");
    const id = createWorkspace(core, { name: "W", projectSlug: "p" });
    const host = new WorkspaceHost(core, id);

    const bobKeys = keypair();
    const x25519 = generateKeyPairSync("x25519");
    savePeer(core.db, {
      deviceId: "e".repeat(16),
      deviceName: "pc",
      user: "bob",
      device: "pc",
      claim: { name: "Bob", email: "bob@x.com" },
      signPubKeyPem: bobKeys.pub,
      encPubKeyPem: x25519.publicKey.export({ type: "spki", format: "pem" }).toString(),
      pairedAt: new Date().toISOString(),
      revokedAt: null,
    });

    const e1 = makeEvent(core.identity.signPrivPem, host.hostAddr, "membership", { op: "add", member: "bob@pc" });
    host.submit(e1);

    const action = makeEvent(core.identity.signPrivPem, host.hostAddr, "action", {
      who: host.hostAddr,
      content: "请审阅方案",
      cc: [host.hostAddr, "bob@pc"],
    });
    const result = host.submit(action);

    const inbox = listInbox(core.db, {});
    const notice = inbox.find((m) => m.subject.startsWith(`[ws:${id.slice(0, 8)}]`));
    expect(notice).toBeDefined();
    expect(notice!.subject).toBe(`[ws:${id.slice(0, 8)}] ${host.hostAddr}: 请审阅方案`);
    expect(notice!.body).toContain(id);

    const outbox = core.db
      .prepare("SELECT payload_json FROM outbox WHERE state = 'queued'")
      .all() as unknown as { payload_json: string }[];
    expect(outbox).toHaveLength(1);
    const payload = JSON.parse(outbox[0]!.payload_json) as { envelope: { to: string; subject: string } };
    expect(payload.envelope.to).toBe("bob@pc");
    expect(payload.envelope.subject).toBe(`[ws:${id.slice(0, 8)}] ${host.hostAddr}: 请审阅方案`);

    // eventId 幂等不重复 CC 通知
    host.submit(action);
    const after = core.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    expect(after.n).toBe(1);
    expect(listInbox(core.db, {}).length).toBe(1);
    expect(result.seq).toBeGreaterThan(0);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxEnv, startStub } from "../testkit.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { resolveDirs } from "../../core/paths.js";
import { savePeer } from "../../core/peer.js";
import { configureDelivery, resetDeliveryConfig } from "../../core/delivery.js";
import { runSend } from "./send.js";
import { runReply } from "./reply.js";
import { seedInbound } from "../testkit.js";
import { get as getMessage, markRead } from "../../core/store.js";
import type { DaemonHandle } from "../../daemon/server.js";

let stub: { handle: DaemonHandle } | undefined;

afterEach(async () => {
  resetDeliveryConfig();
  await stub?.handle.stop();
  stub = undefined;
});

async function startWithPeer(home: string): Promise<{ handle: DaemonHandle; peerAddr: string; peerIdentity: ReturnType<typeof loadOrCreateIdentity> }> {
  const stubbed = await startStub(home);
  stub = stubbed;
  const peerIdentity = loadOrCreateIdentity(
    resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-send-p-")) }),
  );
  savePeer(stubbed.handle.db, {
    deviceId: peerIdentity.deviceId,
    deviceName: peerIdentity.deviceName,
    user: "bob",
    device: peerIdentity.deviceName,
    claim: { name: "Bob", email: "bob@example.com" },
    signPubKeyPem: peerIdentity.signPubPem,
    encPubKeyPem: peerIdentity.encPubPem,
    pairedAt: new Date().toISOString(),
    revokedAt: null,
  });
  configureDelivery({ browse: async () => [] }); // 无对端在线：留出箱
  return { handle: stubbed.handle, peerAddr: `bob@${peerIdentity.deviceName}`, peerIdentity };
}

describe("amail send", () => {
  it("refs → 附件元数据 + parts 密封；daemon 落 out 明文副本并入出箱", async () => {
    const { home, env } = sandboxEnv();
    const { handle, peerAddr, peerIdentity } = await startWithPeer(home);

    const ref = join(home, "ref.txt");
    const payload = Buffer.from("file-content-中文");
    writeFileSync(ref, payload);

    const { messageId } = await runSend(peerAddr, { subject: "标题", body: "正文", refs: [ref], env });
    const message = getMessage(handle.db, messageId);
    expect(message?.direction).toBe("out");
    expect(message?.body).toBe("正文"); // 本机明文 localCopy
    expect(message?.to_addr).toBe(peerAddr);

    const outboxRow = handle.db
      .prepare("SELECT payload_json FROM outbox WHERE payload_json LIKE ?")
      .get(`%${messageId}%`) as { payload_json: string } | undefined;
    expect(outboxRow).toBeDefined();
    const deliverReq = JSON.parse(outboxRow!.payload_json) as {
      envelope: { attachments: Array<{ name: string; sha256: string; size: number }> };
      parts: Array<{ id: string }>;
    };
    expect(deliverReq.envelope.attachments[0]).toMatchObject({
      name: "ref.txt",
      size: payload.length,
    });
    expect(deliverReq.parts).toHaveLength(1);
    // parts 对收件人公钥密封（非明文）
    expect(JSON.stringify(deliverReq.parts[0])).not.toContain("file-content");

    const att = handle.db
      .prepare("SELECT size, sha256 FROM attachments WHERE message_id = ?")
      .get(messageId) as { size: number; sha256: string } | undefined;
    expect(att?.size).toBe(payload.length);
    void peerIdentity;
  });

  it("缺 --subject/--body → 报错", async () => {
    const { home, env } = sandboxEnv();
    await startWithPeer(home);
    await expect(runSend("bob@x", { env })).rejects.toThrow("--subject and --body are required");
  });
});

describe("amail reply", () => {
  it("inReplyTo/thread 链接续：回给原发件人并串线程", async () => {
    const { home, env } = sandboxEnv();
    const { handle, peerAddr } = await startWithPeer(home);
    const originalId = seedInbound(handle.db, {
      envelope: { from: peerAddr, subject: "origin" },
    });

    const { messageId } = await runReply(originalId, { body: "reply body", env });
    const reply = getMessage(handle.db, messageId);
    expect(reply?.direction).toBe("out");
    expect(reply?.to_addr).toBe(peerAddr);
    expect(reply?.in_reply_to).toBe(originalId);
    expect(reply?.thread_root).toBe(getMessage(handle.db, originalId)?.thread_root);
    expect(reply?.subject).toBe("Re: origin");
  });
});

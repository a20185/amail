import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { sandboxEnv, startStub } from "../testkit.js";
import { resolveDirs } from "../../core/paths.js";
import { savePeer } from "../../core/peer.js";
import { get as getMessage } from "../../core/store.js";
import { openBody } from "../../core/crypto.js";
import { configureDelivery, resetDeliveryConfig } from "../../core/delivery.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../../core/identity.js";
import type { DaemonHandle } from "../../daemon/server.js";
import registerHandoff, { runHandoff } from "./handoff.js";
import type { Envelope } from "../../contract/envelope.js";

let stub: { handle: DaemonHandle } | undefined;

afterEach(async () => {
  resetDeliveryConfig();
  await stub?.handle.stop();
  stub = undefined;
});

async function startWithPeer(home: string): Promise<{ handle: DaemonHandle; peerAddr: string; peerIdentity: DeviceIdentityFull }> {
  const stubbed = await startStub(home);
  stub = stubbed;
  const peerIdentity = loadOrCreateIdentity(
    resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-handoff-p-")) }),
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
  configureDelivery({ browse: async () => [] });
  return { handle: stubbed.handle, peerAddr: `bob@${peerIdentity.deviceName}`, peerIdentity };
}

/** CLI 真实入口只读 process.env：临时切到沙箱 AMAIL_HOME */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = { AMAIL_HOME: process.env.AMAIL_HOME, HOME: process.env.HOME };
  process.env.AMAIL_HOME = home;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    for (const key of ["AMAIL_HOME", "HOME"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("amail handoff", () => {
  it("三字段进密封体 handoff 块；body 为 description；refs 随信", async () => {
    const { home, env } = sandboxEnv();
    const { handle, peerAddr, peerIdentity } = await startWithPeer(home);

    const ref = join(home, "plan.md");
    writeFileSync(ref, "phase-5 plan");

    const { messageId } = await runHandoff(peerAddr, {
      progress: "P0-P4 已完成，290 测试绿",
      description: "实现 phase-5 handoff 命令与 amail skill",
      question: ["是否需要备份旧技能目录？"],
      refs: [ref],
      env,
    });

    const message = getMessage(handle.db, messageId);
    expect(message?.direction).toBe("out");
    expect(message?.body).toBe("实现 phase-5 handoff 命令与 amail skill");
    expect(message?.handoff_json).toContain("P0-P4 已完成");

    const outboxRow = handle.db
      .prepare("SELECT payload_json FROM outbox WHERE payload_json LIKE ?")
      .get(`%${messageId}%`) as { payload_json: string } | undefined;
    expect(outboxRow).toBeDefined();
    const deliverReq = JSON.parse(outboxRow!.payload_json) as { envelope: Envelope };

    // 密封体对收件人可解：含 handoff 三字段
    const opened = JSON.parse(openBody(peerIdentity.encPrivPem, deliverReq.envelope.seal).toString("utf8")) as {
      body: string;
      handoff?: { progress: string; description: string; questions: string[] };
      attachmentIds: string[];
    };
    expect(opened.body).toBe("实现 phase-5 handoff 命令与 amail skill");
    expect(opened.handoff).toEqual({
      progress: "P0-P4 已完成，290 测试绿",
      description: "实现 phase-5 handoff 命令与 amail skill",
      questions: ["是否需要备份旧技能目录？"],
    });
    expect(opened.attachmentIds).toHaveLength(1);
  });

  it("缺 --description → body 为缺省摘要", async () => {
    const { home, env } = sandboxEnv();
    const { handle, peerAddr } = await startWithPeer(home);
    const { messageId } = await runHandoff(peerAddr, {
      progress: "进行到一半",
      question: ["下一步？", "谁接手？"],
      env,
    });
    const message = getMessage(handle.db, messageId);
    expect(message?.body).toContain("进行到一半");
    expect(message?.body).toContain("下一步？");
  });

  it("缺 --progress/--question → 报错", async () => {
    const { home, env } = sandboxEnv();
    await startWithPeer(home);
    await expect(runHandoff("bob@x", { env })).rejects.toThrow(
      "--progress and at least one --question are required",
    );
  });

  it("经真实 Commander 解析：--ref 映射到 refs（附件不丢）", async () => {
    const { home } = sandboxEnv();
    const { handle, peerAddr } = await startWithPeer(home);
    const ref = join(home, "handoff-ref.md");
    writeFileSync(ref, "handoff-ref");

    const program = new Command();
    registerHandoff(program);
    await withHome(home, () =>
      program.parseAsync([
        "node",
        "amail",
        "handoff",
        peerAddr,
        "--progress",
        "p",
        "--question",
        "q?",
        "--ref",
        ref,
      ]),
    );

    const row = handle.db
      .prepare("SELECT payload_json FROM outbox")
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json) as {
      envelope: { attachments: Array<{ name: string }> };
    };
    expect(payload.envelope.attachments.map((a) => a.name)).toEqual(["handoff-ref.md"]);
  });
});

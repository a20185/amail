import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxEnv, startStub } from "../testkit.js";
import { apiFetch } from "../../cli/util.js";
import { configureDelivery, resetDeliveryConfig } from "../../core/delivery.js";
import { runPair, runUnpair } from "./pair.js";
import { savePeer } from "../../core/peer.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { resolveDirs } from "../../core/paths.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHandle } from "../../daemon/server.js";
import { userAddress } from "../../daemon/server.js";
import type { PairConfirmSig, PairOffer } from "../../contract/pair.js";
import { enableFakeDiscovery } from "../../daemon/e2e-kit.js";

const stubs: DaemonHandle[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  while (stubs.length) {
    const handle = stubs.pop();
    await handle?.stop();
  }
});

function pendingPoll(dirs: ReturnType<typeof resolveDirs>, user: string): Promise<Array<{ offerNonce: string; user: string }>> {
  return apiFetch(dirs, "/v1/pair/pending").then(
    (list) => (list as Array<{ offerNonce: string; user: string }>).filter((p) => p.user === user),
  ) as Promise<Array<{ offerNonce: string; user: string }>>;
}

async function waitForPending(dirs: ReturnType<typeof resolveDirs>, user: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await pendingPoll(dirs, user);
    if (found.length > 0) return found[0]!.offerNonce;
    if (Date.now() > deadline) throw new Error("pending offer never arrived");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("amail pair / unpair", () => {
  it("应答模式：检测到对端 offer → 自动 answer + 转发，双端 SAS 一致；--confirm 提交本端签名并转发", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    enableFakeDiscovery();

    // A 先发起 offer 并转发到 B（模拟对端 CLI 已执行发起阶段）
    const { offer } = (await apiFetch(resolveDirs(homeA.env), "/v1/pair/local-offer", {
      method: "POST",
    })) as { offer: PairOffer };
    const res = await fetch(`http://127.0.0.1:${stubB.handle.port}/v1/pair/offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(offer),
    });
    expect(res.status).toBe(200);

    // B 运行 amail pair <A 地址> --confirm：自动转入应答模式（answer→SAS→confirm 转发）；
    // 双签收齐需 A 侧也确认——并发补 A 侧 local-confirm + 转发
    const addrA = userAddress(stubA.handle.dirs, stubA.handle.identity);
    const dirsA = resolveDirs(homeA.env);
    const bPairing = runPair(addrA, {
      host: "127.0.0.1",
      port: stubA.handle.port,
      confirm: true,
      env: homeB.env,
    });
    const sasReady = async (): Promise<boolean> => {
      const status = (await apiFetch(dirsA, `/v1/pair/status/${offer.nonce}`)) as { sas: string | null };
      return typeof status.sas === "string";
    };
    const deadline = Date.now() + 5_000;
    while (!(await sasReady())) {
      if (Date.now() > deadline) throw new Error("A never derived SAS");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // A 侧确认：本机签名 + 转发给 B
    const { confirm } = (await apiFetch(dirsA, `/v1/pair/local-confirm/${offer.nonce}`, {
      method: "POST",
    })) as { confirm: PairConfirmSig };
    const forwarded = await fetch(`http://127.0.0.1:${stubB.handle.port}/v1/pair/confirm/${offer.nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(confirm),
    });
    expect([200, 202]).toContain(forwarded.status);

    const status = await bPairing;
    expect(status.sas).toMatch(/^\d{6}$/);
    const statusA = (await apiFetch(dirsA, `/v1/pair/status/${offer.nonce}`)) as {
      sas: string;
      stage: string;
    };
    expect(statusA.sas).toBe(status.sas);
    expect(statusA.stage).toBe("confirmed");
  }, 10_000);

  it("发起模式：本机 local-offer → 转发给对端，收到 answer 后展示 SAS", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    enableFakeDiscovery();
    const dirsA = resolveDirs(homeA.env);
    const dirsB = resolveDirs(homeB.env);

    const pairing = runPair(userAddress(stubB.handle.dirs, stubB.handle.identity), {
      host: "127.0.0.1",
      port: stubB.handle.port,
      env: homeA.env,
    });
    // offer 到达 B 后补应答侧并回传
    const offerNonce = await waitForPending(dirsB, userAddress(stubA.handle.dirs, stubA.handle.identity));
    const { answer } = (await apiFetch(dirsB, `/v1/pair/local-answer/${offerNonce}`, {
      method: "POST",
    })) as { answer: unknown };
    const forwarded = await fetch(`http://127.0.0.1:${stubA.handle.port}/v1/pair/answer/${offerNonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answer),
    });
    expect(forwarded.status).toBe(200);

    const status = await pairing;
    expect(status.sas).toMatch(/^\d{6}$/);
    const statusB = (await apiFetch(dirsB, `/v1/pair/status/${offerNonce}`)) as { sas: string };
    expect(statusB.sas).toBe(status.sas);
  });

  it("两步流程：第一次显示 SAS，第二次 --confirm 复用原 nonce（不新建 offer）", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    enableFakeDiscovery();
    const dirsA = resolveDirs(homeA.env);
    const dirsB = resolveDirs(homeB.env);
    const addrA = userAddress(stubA.handle.dirs, stubA.handle.identity);

    // A 发起 offer 并转发给 B（模拟 A 侧发起阶段）
    const { offer } = (await apiFetch(dirsA, "/v1/pair/local-offer", { method: "POST" })) as {
      offer: PairOffer;
    };
    const forwarded = await fetch(`http://127.0.0.1:${stubB.handle.port}/v1/pair/offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(offer),
    });
    expect(forwarded.status).toBe(200);

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      // 第一次（不带 --confirm）：应答模式 → 显示 SAS，等待人工比对
      const first = await runPair(addrA, {
        host: "127.0.0.1",
        port: stubA.handle.port,
        env: homeB.env,
      });
      expect(first.sas).toMatch(/^\d{6}$/);
      expect(logged.some((line) => line.includes("SAS:"))).toBe(true);

      // 会话已 answer 未 confirm → 仍在 pending（--confirm 可复用原 nonce）
      const pending = (await apiFetch(dirsB, "/v1/pair/pending")) as Array<{ offerNonce: string }>;
      expect(pending.map((p) => p.offerNonce)).toContain(offer.nonce);

      // 第二次（--confirm）：复用原 nonce，不新建 offer
      const second = runPair(addrA, {
        host: "127.0.0.1",
        port: stubA.handle.port,
        confirm: true,
        env: homeB.env,
      });
      // A 侧确认并转发，凑齐双签
      const { confirm } = (await apiFetch(dirsA, `/v1/pair/local-confirm/${offer.nonce}`, {
        method: "POST",
      })) as { confirm: PairConfirmSig };
      const confirmed = await fetch(
        `http://127.0.0.1:${stubB.handle.port}/v1/pair/confirm/${offer.nonce}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(confirm),
        },
      );
      expect([200, 202]).toContain(confirmed.status);

      const status = await second;
      expect(status.stage).toBe("confirmed");
      // 原 nonce 在 A 侧同样推进到 confirmed（新 offer 不会推进原会话）
      const statusA = (await apiFetch(dirsA, `/v1/pair/status/${offer.nonce}`)) as { stage: string };
      expect(statusA.stage).toBe("confirmed");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it("发起方两步流程：A 发起并显示 SAS → A --confirm 复用同一 nonce（不新建 offer）", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    enableFakeDiscovery();
    const dirsA = resolveDirs(homeA.env);
    const addrA = userAddress(stubA.handle.dirs, stubA.handle.identity);
    const addrB = userAddress(stubB.handle.dirs, stubB.handle.identity);

    // A 第一步（无 --confirm）：发起 offer，B 以 CLI 应答 → 双方显示同一 SAS
    const firstA = runPair(addrB, { host: "127.0.0.1", port: stubB.handle.port, env: homeA.env });
    const offerNonceAtB = await waitForPending(resolveDirs(homeB.env), addrA);
    expect(offerNonceAtB).toMatch(/^poffer_/);
    const firstB = await runPair(addrA, { host: "127.0.0.1", port: stubA.handle.port, env: homeB.env });
    const statusA1 = await firstA;
    expect(statusA1.sas).toMatch(/^\d{6}$/);
    expect(statusA1.sas).toBe(firstB.sas);

    // A 发起的「已 answer 未 confirm」会话进入 pending（带 nonce），--confirm 据其复用
    const pendingA = (await apiFetch(dirsA, "/v1/pair/pending")) as Array<{
      offerNonce: string;
      user: string;
      local?: boolean;
    }>;
    const localSessions = pendingA.filter((p) => p.local);
    expect(localSessions).toHaveLength(1);
    expect(localSessions[0]!.user).toBe(addrB);
    const nonce = localSessions[0]!.offerNonce;
    const before = (await apiFetch(dirsA, `/v1/pair/status/${nonce}`)) as { stage: string };
    expect(before.stage).toBe("answered");

    // A 第二步 --confirm（CLI 入口，不手调 confirm 接口）；B 同时 --confirm 收尾
    const secondA = runPair(addrB, {
      host: "127.0.0.1",
      port: stubB.handle.port,
      confirm: true,
      env: homeA.env,
    });
    const secondB = await runPair(addrA, {
      host: "127.0.0.1",
      port: stubA.handle.port,
      confirm: true,
      env: homeB.env,
    });
    expect(secondB.stage).toBe("confirmed");

    const statusA2 = await secondA;
    expect(statusA2.stage).toBe("confirmed");
    expect(statusA2.peer).toBe(addrB);

    // 原 nonce 推进到 confirmed：新 offer 不会推进原会话 → 证明复用而非新建
    const after = (await apiFetch(dirsA, `/v1/pair/status/${nonce}`)) as { stage: string };
    expect(after.stage).toBe("confirmed");
    expect(await apiFetch(dirsA, "/v1/pair/pending")).toEqual([]);
  }, 15_000);

  it("发起方 --confirm 无 pending 会话 → 报错且不新建 offer", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    const dirsA = resolveDirs(homeA.env);
    const dirsB = resolveDirs(homeB.env);
    const addrB = userAddress(stubB.handle.dirs, stubB.handle.identity);

    await expect(
      runPair(addrB, { host: "127.0.0.1", port: stubB.handle.port, confirm: true, env: homeA.env }),
    ).rejects.toThrow(/no pending pairing session/);
    expect(await apiFetch(dirsA, "/v1/pair/pending")).toEqual([]);
    // 未转发任何 offer：对端无待应答会话
    expect(await apiFetch(dirsB, "/v1/pair/pending")).toEqual([]);
  });

  it("缺省 --host/--port：经 mDNS 发现（fake browse 注入）解析后发起配对", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    const dirsB = resolveDirs(homeB.env);
    const addrA = userAddress(stubA.handle.dirs, stubA.handle.identity);
    // 同机双沙箱的 deviceName 相同，构造与 A 自身不同的对端地址（模拟真实双机）
    const addrB = "bob@peer-device";

    // 只注入发现结果：instance 名与 TXT fp 一致 → 采信
    configureDelivery({
      browse: async () => [
        {
          name: `amail-${stubB.handle.identity.deviceId}`,
          host: "127.0.0.1",
          port: stubB.handle.port,
          txt: { fp: stubB.handle.identity.deviceId, user: addrB },
        },
      ],
    });

    const pairing = runPair(addrB, { env: homeA.env });
    const nonce = await waitForPending(dirsB, addrA);
    const { answer } = (await apiFetch(dirsB, `/v1/pair/local-answer/${nonce}`, {
      method: "POST",
    })) as { answer: unknown };
    const forwarded = await fetch(`http://127.0.0.1:${stubA.handle.port}/v1/pair/answer/${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answer),
    });
    expect(forwarded.status).toBe(200);
    expect((await pairing).sas).toMatch(/^\d{6}$/);
  }, 10_000);

  it("mDNS 未发现该设备（或指纹不符）→ 报错含提示且不新建 offer", async () => {
    const { home, env } = sandboxEnv();
    const stubbed = await startStub(home);
    stubs.push(stubbed.handle);
    // TXT user 匹配但 instance 名与 TXT fp 不一致 → 指纹校验失败，不得采信
    configureDelivery({
      browse: async () => [
        { name: "amail-not-the-advertised-fp", host: "127.0.0.1", port: stubbed.handle.port, txt: { fp: "deadbeef", user: "bob@ghost" } },
      ],
    });
    await expect(runPair("bob@ghost", { env })).rejects.toThrow(
      /未发现该设备[\s\S]*显式指定 --host\/--port/,
    );
    expect(await apiFetch(stubbed.dirs, "/v1/pair/pending")).toEqual([]);
  });

  it("发起方重跑普通 pair：已 answer → 显示 SAS 并复用原 nonce（不新建 offer）", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    const dirsA = resolveDirs(homeA.env);
    const dirsB = resolveDirs(homeB.env);
    const addrA = userAddress(stubA.handle.dirs, stubA.handle.identity);
    const addrB = userAddress(stubB.handle.dirs, stubB.handle.identity);

    // 第一步：A 发起，B 应答 → 双方拿到同一 SAS
    const firstA = runPair(addrB, { host: "127.0.0.1", port: stubB.handle.port, env: homeA.env });
    const nonce = await waitForPending(dirsB, addrA);
    const firstB = await runPair(addrA, { host: "127.0.0.1", port: stubA.handle.port, env: homeB.env });
    const statusA1 = await firstA;
    expect(statusA1.sas).toBe(firstB.sas);

    // 第二步：A 重跑普通 pair（不带 --confirm）→ 直接显示待确认 SAS，不新建 offer
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const again = await runPair(addrB, {
        host: "127.0.0.1",
        port: stubB.handle.port,
        env: homeA.env,
      });
      expect(again.sas).toBe(statusA1.sas);
      expect(again.stage).toBe("answered");
      expect(logged.some((line) => line.includes("SAS:"))).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // 未新建 offer：A/B 两侧仍只有原会话
    const pendingA = (await apiFetch(dirsA, "/v1/pair/pending")) as Array<{ offerNonce: string }>;
    expect(pendingA.map((p) => p.offerNonce)).toEqual([nonce]);
    const pendingB = (await apiFetch(dirsB, "/v1/pair/pending")) as Array<{ offerNonce: string }>;
    expect(pendingB.map((p) => p.offerNonce)).toEqual([nonce]);
  }, 15_000);

  it("发起方重跑普通 pair：仅 offer（未 answer）→ 提示等待对端应答并保留原会话", async () => {
    const homeA = sandboxEnv();
    const homeB = sandboxEnv();
    const stubA = await startStub(homeA.home);
    const stubB = await startStub(homeB.home);
    stubs.push(stubA.handle, stubB.handle);
    const dirsA = resolveDirs(homeA.env);
    const addrB = userAddress(stubB.handle.dirs, stubB.handle.identity);

    // 已有本机发起的会话（尚未收到 answer），CLI 声明的目标地址用于关联
    const { offer } = (await apiFetch(dirsA, "/v1/pair/local-offer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: addrB }),
    })) as { offer: PairOffer };

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const status = await runPair(addrB, {
        host: "127.0.0.1",
        port: stubB.handle.port,
        env: homeA.env,
      });
      expect(status.stage).toBe("offer");
      expect(status.sas).toBeNull();
      expect(logged.some((line) => line.includes("等待对端应答"))).toBe(true);
    } finally {
      spy.mockRestore();
    }

    const pendingA = (await apiFetch(dirsA, "/v1/pair/pending")) as Array<{ offerNonce: string }>;
    expect(pendingA.map((p) => p.offerNonce)).toEqual([offer.nonce]);
  });

  it("amail unpair：吊销已配对地址；未配对返回 false", async () => {
    const { home, env } = sandboxEnv();
    const stubbed = await startStub(home);
    stubs.push(stubbed.handle);
    const peerIdentity = loadOrCreateIdentity(
      resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-pair-c-")) }),
    );
    const addr = `bob@${peerIdentity.deviceName}`;
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
    expect(await runUnpair(addr, { env })).toBe(true);
    expect(await runUnpair(addr, { env })).toBe(false);
  });
});

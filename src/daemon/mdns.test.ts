import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirs } from "../core/paths.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import {
  AdvertiseTimeoutError,
  advertise,
  browsePeers,
  createFakeResponder,
  parseResponse,
  type AdvertiseService,
  type CiaoLike,
  type CiaoResponderLike,
  type MdnsResponder,
  type PeerAdvertisement,
} from "./mdns.js";

function dnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".");
  return Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "latin1")])),
    Buffer.from([0]),
  ]);
}

/** 构造单条 SRV 应答（priority=0, weight=0, port 可指定） */
function srvPacket(port: number, target = "mbp16.local"): Buffer {
  const targetBuf = dnsName(target);
  const rdata = Buffer.alloc(6 + targetBuf.length);
  rdata.writeUInt16BE(0, 0); // priority
  rdata.writeUInt16BE(0, 2); // weight
  rdata.writeUInt16BE(port, 4); // port
  targetBuf.copy(rdata, 6);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response + authoritative
  header.writeUInt16BE(0, 4); // qdcount
  header.writeUInt16BE(1, 6); // ancount

  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(33, 0); // SRV
  rr.writeUInt16BE(0x8001, 2); // IN + cache-flush
  rr.writeUInt32BE(120, 4); // ttl
  rr.writeUInt16BE(rdata.length, 8);

  return Buffer.concat([header, dnsName("_amail._tcp.local"), rr, rdata]);
}

function sandbox() {
  return resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-")) });
}

/**
 * 模拟 ciao 引用计数语义的 fake：getResponder() 每次 ++ 并返回同一单例，
 * shutdown() 先 --，归零才真正关闭（停止“探测”定时器）。
 */
function refCountingCiao(opts: { advertiseResolves: boolean }) {
  let refs = 0;
  let getResponderCalls = 0;
  let probeTicks = 0;
  let timer: NodeJS.Timeout | undefined;
  let closedInstance: unknown;
  const instance: CiaoResponderLike = {
    createService: () => ({
      advertise: () => {
        timer = setInterval(() => void (probeTicks += 1), 5);
        timer.unref?.();
        return opts.advertiseResolves ? Promise.resolve() : new Promise<never>(() => {});
      },
      end: async () => {},
    }),
    async shutdown() {
      refs -= 1;
      if (refs > 0) return;
      closedInstance = instance;
      clearInterval(timer);
      timer = undefined;
    },
  };
  const ciao: CiaoLike = {
    getResponder: () => {
      getResponderCalls += 1;
      refs += 1;
      return instance;
    },
  };
  return {
    load: async (): Promise<CiaoLike> => ciao,
    instance,
    refs: () => refs,
    getResponderCalls: () => getResponderCalls,
    probeTicks: () => probeTicks,
    /** 探测循环是否仍在跑（shutdown 归零后应停止） */
    probing: () => timer !== undefined,
    closedInstance: () => closedInstance,
  };
}

describe("mDNS advertise（fake responder 注入，不真发组播）", () => {
  it("广播 _amail._tcp 服务，TXT {fp,user,ver}", async () => {
    const dirs = sandbox();
    const identity = loadOrCreateIdentity(dirs);
    const seen: AdvertiseService[] = [];
    let ended = false;
    const handle = await advertise(dirs, 41234, {
      responder: {
        advertise: async (service) => {
          seen.push(service);
          return { end: async () => void (ended = true) };
        },
        browse: async () => [],
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("amail");
    expect(seen[0]!.protocol).toBe("tcp");
    expect(seen[0]!.port).toBe(41234);
    expect(seen[0]!.txt.fp).toBe(identity.deviceId);
    expect(seen[0]!.txt.user).toMatch(/@/);
    expect(seen[0]!.txt.ver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(seen[0]!.name).toBe(`amail-${identity.deviceId}`);
    await handle.end();
    expect(ended).toBe(true);
  });

  it("广播超时：responder 永不 resolve → 限时 reject 并走取消路径（shutdown）", async () => {
    const dirs = sandbox();
    let shutdownCalled = false;
    const never: MdnsResponder = {
      advertise: () => Promise.withResolvers<never>().promise,
      browse: async () => [],
      async shutdown() {
        shutdownCalled = true;
      },
    };
    const startedAt = Date.now();
    const err = await advertise(dirs, 40000, { responder: never, advertiseTimeoutMs: 30 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdvertiseTimeoutError);
    expect((err as Error).message).toMatch(/timed out after 30ms/);
    expect(shutdownCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("广播超时：关闭的是首次取得的同一 ciao 实例，探测循环停止", async () => {
    const dirs = sandbox();
    const ciao = refCountingCiao({ advertiseResolves: false });
    const err = await advertise(dirs, 41234, {
      loadCiao: ciao.load,
      advertiseTimeoutMs: 30,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdvertiseTimeoutError);
    // 取消路径不得二次 getResponder（ciao 引用计数 1→2→1 会漏减，实例永不关闭）
    expect(ciao.getResponderCalls()).toBe(1);
    expect(ciao.refs()).toBe(0);
    expect(ciao.closedInstance()).toBe(ciao.instance);
    expect(ciao.probing()).toBe(false);
  });

  it("广播成功：end 释放同一实例（引用计数归零、探测停止）", async () => {
    const dirs = sandbox();
    const ciao = refCountingCiao({ advertiseResolves: true });
    const handle = await advertise(dirs, 41234, { loadCiao: ciao.load });
    expect(ciao.refs()).toBe(1);
    await handle.end();
    expect(ciao.getResponderCalls()).toBe(1);
    expect(ciao.refs()).toBe(0);
    expect(ciao.closedInstance()).toBe(ciao.instance);
    expect(ciao.probing()).toBe(false);
  });
});

describe("mDNS 发现链路（fake responder 走生产 advertise/browse 路径）", () => {
  it("advertise(port) → browsePeers 返回该 host/port/TXT；end 后撤销", async () => {
    const dirs = sandbox();
    const identity = loadOrCreateIdentity(dirs);
    const responder = createFakeResponder();

    const handle = await advertise(dirs, 41234, { responder });
    const ads = await browsePeers(10, { responder });
    expect(ads).toHaveLength(1);
    expect(ads[0]).toMatchObject({ name: `amail-${identity.deviceId}`, host: "127.0.0.1", port: 41234 });
    expect(ads[0]!.txt).toMatchObject({ fp: identity.deviceId, ver: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(ads[0]!.txt.user).toMatch(/@/);

    await handle.end();
    expect(await browsePeers(10, { responder })).toEqual([]);
  });
});

describe("mDNS SRV 解析（原始字节）", () => {
  it("SRV RDATA 偏移 4 = port（priority/weight 各 2B 在前）", () => {
    const records = parseResponse(srvPacket(36969));
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("_amail._tcp.local");
    expect(records[0]!.srv).toEqual({ target: "mbp16.local", port: 36969 });
  });

  it("weight 非 0 时仍取 port（防再次读错偏移）", () => {
    const packet = srvPacket(41234, "other.local");
    // weight 段写 7：错读偏移 2 会得到 7
    packet.writeUInt16BE(7, packet.length - dnsName("other.local").length - 6 + 2);
    expect(parseResponse(packet)[0]!.srv).toEqual({ target: "other.local", port: 41234 });
  });
});

describe("mDNS browsePeers（fake 注入）", () => {
  it("返回 [{name,host,port,txt}]", async () => {
    const peers: PeerAdvertisement[] = [
      {
        name: "amail-0123456789abcdef",
        host: "mbp16.local",
        port: 36969,
        txt: { fp: "0123456789abcdef", user: "alice@mbp16", ver: "0.0.1" },
      },
    ];
    const result = await browsePeers(5, {
      responder: {
        advertise: async () => ({ end: async () => {} }),
        browse: async () => peers,
      },
    });
    expect(result).toEqual(peers);
  });
});

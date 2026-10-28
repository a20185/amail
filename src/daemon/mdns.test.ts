import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirs } from "../core/paths.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { advertise, browsePeers, parseResponse, type AdvertiseService, type PeerAdvertisement } from "./mdns.js";

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

describe("mDNS advertise（fake 注入，不真发组播）", () => {
  it("广播 _amail._tcp 服务，TXT {fp,user,ver}", async () => {
    const dirs = sandbox();
    const identity = loadOrCreateIdentity(dirs);
    const seen: AdvertiseService[] = [];
    let ended = false;
    const handle = await advertise(dirs, 41234, {
      advertiseImpl: async (service) => {
        seen.push(service);
        return { end: async () => void (ended = true) };
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
    const result = await browsePeers(5, { browseImpl: async () => peers });
    expect(result).toEqual(peers);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirs } from "../core/paths.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { advertise, browsePeers, type AdvertiseService, type PeerAdvertisement } from "./mdns.js";

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

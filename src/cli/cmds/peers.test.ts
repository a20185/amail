import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxEnv, startStub } from "../testkit.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { resolveDirs } from "../../core/paths.js";
import { savePeer } from "../../core/peer.js";
import { configureDelivery, resetDeliveryConfig } from "../../core/delivery.js";
import { showPeers } from "./peers.js";
import { userAddress } from "../../daemon/server.js";
import type { DaemonHandle } from "../../daemon/server.js";

let stub: { handle: DaemonHandle } | undefined;

afterEach(async () => {
  resetDeliveryConfig();
  await stub?.handle.stop();
  stub = undefined;
});

describe("amail peers", () => {
  it("列出已配对设备（含指纹与设备名）", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const handle = stub.handle;
    const peerIdentity = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-p-")) }));
    savePeer(handle.db, {
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
    const peers = (await showPeers({ env })) as Array<{ user: string; deviceId: string }>;
    expect(peers).toHaveLength(1);
    expect(peers[0]?.user).toBe("bob");
    expect(peers[0]?.deviceId).toBe(peerIdentity.deviceId);
  });

  it("--scan 经 fake mdns 列出局域网设备（过滤本机）", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const self = stub.handle;
    const otherHome = mkdtempSync(join(tmpdir(), "amail-p2-"));
    const other = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: otherHome }));
    configureDelivery({
      browse: async () => [
        { name: `amail-${self.identity.deviceId}`, host: "127.0.0.1", port: self.port, txt: { fp: self.identity.deviceId, user: userAddress(self.dirs, self.identity) } },
        { name: `amail-${other.deviceId}`, host: "10.0.0.9", port: 36969, txt: { fp: other.deviceId, user: "carol@laptop" } },
      ],
    });
    const items = (await showPeers({ scan: true, env })) as Array<{ user: string; host: string; fp: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ user: "carol@laptop", host: "10.0.0.9", fp: other.deviceId });
  });

  it("未配对时列空", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    expect(await showPeers({ env })).toHaveLength(0);
  });
});

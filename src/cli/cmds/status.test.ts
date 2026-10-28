import { afterEach, describe, expect, it } from "vitest";
import { sandboxEnv, seedInbound, startStub } from "../testkit.js";
import { savePeer } from "../../core/peer.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { resolveDirs } from "../../core/paths.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showStatus } from "./status.js";
import type { DaemonHandle } from "../../daemon/server.js";

let stub: { handle: DaemonHandle } | undefined;

afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("amail status", () => {
  it("概况：daemon/未读/出箱/peers", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    seedInbound(stub.handle.db, { body: "unread one" });
    seedInbound(stub.handle.db, { body: "unread two" });

    const peerIdentity = loadOrCreateIdentity(
      resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-stat-c-")) }),
    );
    savePeer(stub.handle.db, {
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

    const status = await showStatus({ env });
    expect(status.unread).toBe(2);
    expect(status.peers).toBe(1);
    expect(status.outbox).toEqual({ queued: 0, delivered: 0, expired: 0 });
    expect(status.address).toContain("@");
  });
});

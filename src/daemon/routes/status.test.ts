import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { savePeer } from "../../core/peer.js";
import { seedInbound } from "../../cli/testkit.js";
import { markRead } from "../../core/store.js";
import { enqueue, markDelivered } from "../../core/outbox.js";
import { buildDeliverReq } from "../../cli/testkit.js";
import { EventBus } from "../sse.js";
import route from "./status.js";
import type { RouteCtx } from "../router.js";

class FakeRes {
  statusCode = 200;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(data?: unknown): this {
    if (typeof data === "string") this.body += data;
    return this;
  }
}

function setup(): { dirs: Dirs; db: DatabaseSync } {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-stat-")) });
  return { dirs, db: openStore(dirs.storePath) };
}

async function call(ctx: { dirs: Dirs; db: DatabaseSync }) {
  const res = new FakeRes();
  await route[0]!.handler({
    req: { method: "GET" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    params: {},
    query: new URLSearchParams(),
    identity: loadOrCreateIdentity(ctx.dirs),
    dirs: ctx.dirs,
    db: ctx.db,
    bus: new EventBus(),
  } as RouteCtx);
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

describe("routes/status", () => {
  it("概况：版本/地址/未读/出箱各状态数/已配对数", async () => {
    const ctx = setup();
    const identity = loadOrCreateIdentity(ctx.dirs);
    const id1 = seedInbound(ctx.db, { body: "unread" });
    seedInbound(ctx.db, { body: "read" });
    markRead(ctx.db, id1);
    const peerIdentity = loadOrCreateIdentity(
      resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-stat-p-")) }) as Dirs,
    );
    savePeer(ctx.db, {
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

    const req1 = buildDeliverReq(identity, peerIdentity, { toAddr: "bob@x" });
    const req2 = buildDeliverReq(identity, peerIdentity, { toAddr: "bob@x" });
    const outDelivered = enqueue(ctx.db, req1);
    markDelivered(ctx.db, outDelivered);
    enqueue(ctx.db, req2);

    const { status, json } = await call(ctx);
    expect(status).toBe(200);
    expect(json.unread).toBe(1);
    expect(json.outbox).toEqual({ queued: 1, delivered: 1, expired: 0 });
    expect(json.peers).toBe(1);
    expect(String(json.address)).toContain("@");
    expect(typeof json.version).toBe("string");
  });

  it("空库：全零", async () => {
    const ctx = setup();
    const { json } = await call(ctx);
    expect(json.unread).toBe(0);
    expect(json.outbox).toEqual({ queued: 0, delivered: 0, expired: 0 });
    expect(json.peers).toBe(0);
  });
});

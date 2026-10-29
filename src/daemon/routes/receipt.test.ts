import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../../core/identity.js";
import { savePeer } from "../../core/peer.js";
import { seedInbound } from "../../cli/testkit.js";
import { signCanonical } from "../../core/crypto.js";
import { EventBus, type BusEvent } from "../sse.js";
import route from "./receipt.js";
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

interface ReceiptRow {
  message_id: string;
  kind: string;
}

function setup() {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-rcpt-")) });
  const db = openStore(dirs.storePath);
  const peerHome = mkdtempSync(join(tmpdir(), "amail-rcpt-peer-"));
  const peerIdentity = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: peerHome }) as Dirs);
  savePeer(db, {
    deviceId: peerIdentity.deviceId,
    deviceName: peerIdentity.deviceName,
    user: "alice",
    device: peerIdentity.deviceName,
    claim: { name: "Alice", email: "alice@example.com" },
    signPubKeyPem: peerIdentity.signPubPem,
    encPubKeyPem: peerIdentity.encPubPem,
    pairedAt: new Date().toISOString(),
    revokedAt: null,
  });
  return { dirs, db, peerIdentity, bus: new EventBus() };
}

async function call(
  ctx: { dirs: Dirs; db: DatabaseSync; peerIdentity: DeviceIdentityFull; bus: EventBus },
  body: unknown,
): Promise<{ status: number; json: <T,>() => T }> {
  const res = new FakeRes();
  await route[0]!.handler({
    req: { method: "POST" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    params: {},
    query: new URLSearchParams(),
    identity: ctx.peerIdentity as unknown as RouteCtx["identity"],
    dirs: ctx.dirs,
    db: ctx.db,
    bus: ctx.bus,
    body,
  } as RouteCtx);
  return { status: res.statusCode, json: <T,>() => JSON.parse(res.body) as T };
}

function receipt(messageId: string, kind: "delivered" | "read", signerPriv: string): unknown {
  const unsigned = { messageId, kind, at: new Date().toISOString() };
  return { ...unsigned, sig: signCanonical(signerPriv, unsigned) };
}

describe("routes/receipt", () => {
  it("来信回执：验签通过 → receipts 落库 + bus receipt 事件", async () => {
    const ctx = setup();
    const id = seedInbound(ctx.db, { envelope: { from: `alice@${ctx.peerIdentity.deviceName}` } });
    const events: BusEvent[] = [];
    ctx.bus.on((event) => events.push(event));
    const res = await call(ctx, receipt(id, "delivered", ctx.peerIdentity.signPrivPem));
    expect(res.status).toBe(200);
    const rows = ctx.db
      .prepare("SELECT message_id, kind FROM receipts")
      .all() as unknown as ReceiptRow[];
    expect(rows).toEqual([{ message_id: id, kind: "delivered" }]);
    expect(events.some((e) => e.type === "receipt")).toBe(true);
  });

  it("未知信件 → 404", async () => {
    const ctx = setup();
    const res = await call(ctx, receipt("msg_01M61CHRC25BCYH10EHVCHSPRE", "read", ctx.peerIdentity.signPrivPem));
    expect(res.status).toBe(404);
  });

  it("验签失败 → 401，不落库", async () => {
    const ctx = setup();
    const otherHome = mkdtempSync(join(tmpdir(), "amail-rcpt-other-"));
    const other = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: otherHome }) as Dirs);
    const id = seedInbound(ctx.db, { envelope: { from: `alice@${ctx.peerIdentity.deviceName}` } });
    const res = await call(ctx, receipt(id, "read", other.signPrivPem));
    expect(res.status).toBe(401);
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM receipts").get()).toEqual({ c: 0 });
  });
});

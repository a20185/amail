import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { resolveDirs } from "./paths.js";
import { openStore } from "./db.js";
import { loadOrCreateIdentity } from "./identity.js";
import { savePeer } from "./peer.js";
import { enqueue, get as outboxGet } from "./outbox.js";
import { EventBus } from "../daemon/sse.js";
import {
  configureDelivery,
  resetDeliveryConfig,
  deliverOutboxItem,
  peerBaseUrl,
  resolvePeerTarget,
  scanOutbox,
  type PeerTarget,
} from "./delivery.js";
import type { DaemonCore } from "../daemon/router.js";
import { buildDeliverReq } from "../cli/testkit.js";

const servers: Server[] = [];
const savedHome = process.env.AMAIL_HOME;

afterEach(() => {
  resetDeliveryConfig();
  for (const server of servers.splice(0)) server.closeAllConnections?.(), server.close();
  if (savedHome === undefined) delete process.env.AMAIL_HOME;
  else process.env.AMAIL_HOME = savedHome;
});

function core(): DaemonCore {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-dlv-")) });
  return { db: openStore(dirs.storePath), dirs, identity: loadOrCreateIdentity(dirs), bus: new EventBus() };
}

async function stubServer(handler: (req: { url?: string }, res: { statusCode: number; end: (b?: string) => void }) => void): Promise<PeerTarget> {
  const server = createServer(handler);
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.once("listening", onListening);
  server.listen(0, "127.0.0.1");
  await listening;
  servers.push(server);
  const address = server.address();
  return { host: "127.0.0.1", port: typeof address === "object" && address ? address.port : 0 };
}

describe("resolvePeerTarget", () => {
  it("按 TXT fp 指纹匹配对端地址", async () => {
    configureDelivery({
      browse: async () => [
        { name: "other", host: "10.0.0.5", port: 36969, txt: { fp: "aaaa1111aaaa1111" } },
        { name: "want", host: "10.0.0.6", port: 12345, txt: { fp: "deadbeefdeadbeef" } },
      ],
    });
    await expect(resolvePeerTarget("deadbeefdeadbeef")).resolves.toEqual({ host: "10.0.0.6", port: 12345 });
    await expect(resolvePeerTarget("ffffffffffffffff")).resolves.toBeUndefined();
  });

  it("peerBaseUrl 拼 LAN 地址", () => {
    expect(peerBaseUrl({ host: "10.0.0.6", port: 12345 })).toBe("http://10.0.0.6:12345");
  });
});

describe("deliverOutboxItem / attemptDelivery", () => {
  it("对端 200 → markDelivered；非 2xx → 记失败按退避", async () => {
    const { db, dirs, identity, bus } = core();
    // 配对一个假对端，指向本地 stub server
    const peerHome = mkdtempSync(join(tmpdir(), "amail-dlv-peer-"));
    const peerIdentity = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: peerHome }));
    const target = await stubServer((req, res) => {
      if (req.url === "/v1/deliver") {
        res.statusCode = 200;
        res.end(JSON.stringify({ deliveredAt: new Date().toISOString() }));
      } else {
        res.statusCode = 500;
        res.end("{}");
      }
    });
    savePeer(db, {
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
    configureDelivery({
      browse: async () => [{ name: "bob", host: target.host, port: target.port, txt: { fp: peerIdentity.deviceId } }],
    });

    const req = buildDeliverReq(identity, peerIdentity, { toAddr: `bob@${peerIdentity.deviceName}` });
    const outboxId = enqueue(db, req);
    const coreObj: DaemonCore = { db, dirs, identity, bus };
    await expect(deliverOutboxItem(coreObj, outboxId)).resolves.toBe(true);
    expect(outboxGet(db, outboxId)?.state).toBe("delivered");

    // 失败路径：把对端换成 500 的 stub
    const badTarget = await stubServer((_req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    configureDelivery({
      browse: async () => [{ name: "bob", host: badTarget.host, port: badTarget.port, txt: { fp: peerIdentity.deviceId } }],
    });
    const id2 = enqueue(db, buildDeliverReq(identity, peerIdentity, { toAddr: `bob@${peerIdentity.deviceName}` }));
    await expect(deliverOutboxItem(coreObj, id2)).resolves.toBe(false);
    const row = outboxGet(db, id2);
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain("500");
  });

  it("未配对收件人：记失败不入网络", async () => {
    const { db, dirs, identity, bus } = core();
    const peerIdentity = loadOrCreateIdentity(
      resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-dlv-p2-")) }),
    );
    const id = enqueue(db, buildDeliverReq(identity, peerIdentity, { toAddr: "ghost@nowhere" }));
    await expect(deliverOutboxItem({ db, dirs, identity, bus }, id)).resolves.toBe(false);
    expect(outboxGet(db, id)?.last_error).toContain("not paired");
  });
});

describe("scanOutbox", () => {
  it("72h 过期：state=expired + bus outbox 事件 + 发件人 notify", async () => {
    const { db, dirs, identity, bus } = core();
    process.env.AMAIL_NOTIFY_CMD = ":";
    const peerIdentity = loadOrCreateIdentity(
      resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-dlv-p3-")) }),
    );
    const req = buildDeliverReq(identity, peerIdentity, { toAddr: "bob@dev" });
    const id = enqueue(db, req, Date.now() - 73 * 3_600_000);
    const events: unknown[] = [];
    bus.on((event) => {
      events.push(event);
    });
    await scanOutbox({ db, dirs, identity, bus });
    expect(outboxGet(db, id)?.state).toBe("expired");
    expect(events).toContainEqual({
      type: "outbox",
      data: { state: "expired", outboxId: id, messageId: req.envelope.id, to: "bob@dev" },
    });
    delete process.env.AMAIL_NOTIFY_CMD;
  });
});

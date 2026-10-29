import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveDirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { DeliverReqSchema } from "../../contract/api.js";
import { due as dueOutbox } from "../../core/outbox.js";
import { get as getMessage } from "../../core/store.js";
import { openBody } from "../../core/crypto.js";
import { EventBus, type BusEvent } from "../sse.js";
import route from "./send-local.js";
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

async function call(ctx: {
  db: RouteCtx["db"];
  dirs: RouteCtx["dirs"];
  identity: RouteCtx["identity"];
  bus: EventBus;
  body: unknown;
}) {
  const res = new FakeRes();
  try {
    await route[0]!.handler({
      req: { method: "POST" } as IncomingMessage,
      res: res as unknown as ServerResponse,
      params: {},
      query: new URLSearchParams(),
      ...ctx,
    } as RouteCtx);
  } catch {
    // 抛错路径在生产由 server 层转 500；此处按 500 断言
    if (res.body === "") {
      res.statusCode = 500;
      res.body = '{"error":"thrown"}';
    }
  }
  return { status: res.statusCode, json: <T,>() => JSON.parse(res.body) as T };
}

function setup() {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-send-")) });
  const peerDirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-peer-")) });
  const peerIdentity = loadOrCreateIdentity(peerDirs);
  const db = openStore(dirs.storePath);
  db.prepare(
    `INSERT INTO peers (device_id, device_name, user, device, claim_name, claim_email,
     sign_pub_pem, enc_pub_pem, paired_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    peerIdentity.deviceId,
    peerIdentity.deviceName,
    "bob",
    peerIdentity.deviceName,
    "bob",
    "bob@example.com",
    peerIdentity.signPubPem,
    peerIdentity.encPubPem,
    new Date().toISOString(),
  );
  return { dirs, db, identity: loadOrCreateIdentity(dirs), peerIdentity };
}

const TO = (device: string) => `bob@${device}`;

describe("POST /v1/send", () => {
  it("未配对 → 409 not-paired，不产生任何落库", async () => {
    const { dirs, db, identity } = setup();
    const res = await call({
      db,
      dirs,
      identity,
      bus: new EventBus(),
      body: { to: "stranger@unknown-dev", subject: "hi", body: "b", refs: [] },
    });
    expect(res.status).toBe(409);
    expect(res.json<{ error: string; hint: string }>().error).toBe("not-paired");
    expect(db.prepare("SELECT COUNT(*) c FROM messages").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM outbox").get()).toMatchObject({ c: 0 });
  });

  it("已配对：密封+签名+saveOutbound 原子落库，emit outbox，返回 messageId", async () => {
    const { dirs, db, identity, peerIdentity } = setup();
    const bus = new EventBus();
    const events: BusEvent[] = [];
    bus.on((e) => events.push(e));

    const refFile = join(dirs.home, "note.txt");
    writeFileSync(refFile, "attachment-bytes");

    const res = await call({
      db,
      dirs,
      identity,
      bus,
      body: {
        to: TO(peerIdentity.deviceName),
        subject: "hello",
        body: "明文正文",
        refs: [refFile],
        handoff: { progress: "50%", description: "进行中", questions: ["下一步?"] },
      },
    });
    expect(res.status).toBe(200);
    const { messageId } = res.json<{ messageId: string }>();

    // 本机明文副本
    const row = getMessage(db, messageId);
    expect(row?.body).toBe("明文正文");
    expect(row?.direction).toBe("out");
    expect(JSON.parse(row!.handoff_json!)).toMatchObject({ progress: "50%" });

    // 出箱：payload 是合法 DeliverReq（信封+密封附件 parts）
    const outRows = dueOutbox(db, Number.POSITIVE_INFINITY);
    expect(outRows).toHaveLength(1);
    const deliverReq = DeliverReqSchema.parse(JSON.parse(outRows[0]!.payload_json));
    expect(deliverReq.envelope.id).toBe(messageId);
    expect(deliverReq.parts).toHaveLength(1);
    // 附件密封体可被对端解封
    const opened = openBody(peerIdentity.encPrivPem, deliverReq.parts[0]!.seal);
    expect(opened.toString("utf8")).toBe("attachment-bytes");

    expect(events).toEqual([
      { type: "outbox", data: { messageId, outboxId: outRows[0]!.id, to: TO(peerIdentity.deviceName) } },
    ]);
  });

  it("ref 不可读 → 400", async () => {
    const { dirs, db, identity, peerIdentity } = setup();
    const res = await call({
      db,
      dirs,
      identity,
      bus: new EventBus(),
      body: {
        to: TO(peerIdentity.deviceName),
        subject: "s",
        body: "b",
        refs: [join(dirs.home, "missing.bin")],
      },
    });
    expect(res.status).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("unreadable-ref");
  });

  it("非法载荷（缺 subject）→ 500/参数错误而非落库", async () => {
    const { dirs, db, identity, peerIdentity } = setup();
    const res = await call({
      db,
      dirs,
      identity,
      bus: new EventBus(),
      body: { to: TO(peerIdentity.deviceName), body: "b", refs: [] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.prepare("SELECT COUNT(*) c FROM messages").get()).toMatchObject({ c: 0 });
  });
});

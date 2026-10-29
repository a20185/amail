import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveDirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { AliveInfoSchema } from "../../contract/api.js";
import { EventBus } from "../sse.js";
import { userAddress } from "../server.js";
import alive from "./alive.js";
import type { RouteCtx } from "../router.js";

function setup() {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-alive-")) });
  return { dirs, db: openStore(dirs.storePath), identity: loadOrCreateIdentity(dirs) };
}

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

function call(route: (typeof alive)[number], ctx: Partial<RouteCtx>) {
  const res = new FakeRes();
  route.handler({
    req: { method: "GET" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    db: undefined as never,
    dirs: undefined as never,
    identity: undefined as never,
    bus: new EventBus(),
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    ...ctx,
  } as RouteCtx);
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe("GET /alive", () => {
  it("200 + AliveInfo 形状（peers 计数来自 db，未配对为 0）", () => {
    const { dirs, db, identity } = setup();
    const { status, body } = call(alive[0]!, { db, dirs, identity });
    expect(status).toBe(200);
    expect(AliveInfoSchema.parse(body)).toBeTruthy();
    expect(body.fingerprint).toBe(identity.deviceId);
    expect(body.user).toBe(userAddress(dirs, identity));
    expect(body.pairedCount).toBe(0);
  });

  it("peers 计数排除已吊销对端", () => {
    const { dirs, db, identity } = setup();
    db.prepare(
      `INSERT INTO peers (device_id, device_name, user, device, claim_name, claim_email,
       sign_pub_pem, enc_pub_pem, paired_at, revoked_at) VALUES
       ('aaaaaaaaaaaaaaaa', 'd', 'bob', 'bobdev', 'bob', 'bob@example.com', 's', 'e', '2026-01-01T00:00:00Z', NULL),
       ('bbbbbbbbbbbbbbbb', 'd', 'carol', 'caroldev', 'carol', 'carol@example.com', 's', 'e', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
    ).run();
    const { body } = call(alive[0]!, { db, dirs, identity });
    expect(body.pairedCount).toBe(1);
  });
});

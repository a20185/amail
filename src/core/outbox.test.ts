import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "./db.js";
import {
  backoffFor,
  due,
  enqueue,
  expireDue,
  get,
  markAttempt,
  markAttemptWithBackoff,
  markDelivered,
  RETRY_MAX_MS,
} from "./outbox.js";
import type { DeliverReq } from "../contract/api.js";
import type { Envelope } from "../contract/envelope.js";

const T0 = 1_000_000;

function freshDb() {
  return openStore(join(mkdtempSync(join(tmpdir(), "amail-outbox-")), "store.db"));
}

function req(): DeliverReq {
  const envelope: Envelope = {
    v: 1,
    id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
    from: "alice@mbp16",
    to: "bob@thinkpadx1",
    subject: "s",
    inReplyTo: null,
    references: [],
    createdAt: "2026-10-27T09:00:00.000Z",
    claim: { name: "Alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm", epk: "ZXBk", iv: "aXY=", body: "Y2lwaGVy" },
    attachments: [],
    sig: "c2ln",
  };
  return { envelope, parts: [] };
}

describe("enqueue", () => {
  it("入箱即 queued、attempts=0、payload 为 DeliverReq 完整序列化、expires_at=+72h", () => {
    const db = freshDb();
    const payload = req();
    const id = enqueue(db, payload, T0);
    const row = get(db, id)!;
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.next_retry_at).toBe(T0);
    expect(row.created_at).toBe(T0);
    expect(row.expires_at).toBe(T0 + 72 * 3_600_000);
    expect(JSON.parse(row.payload_json)).toEqual(payload);
    db.close();
  });
});

describe("due", () => {
  it("只返回 next_retry_at ≤ now 的 queued 项", () => {
    const db = freshDb();
    const a = enqueue(db, req(), T0);
    const b = enqueue(db, req(), T0 + 60_000);
    expect(due(db, T0).map((r) => r.id)).toEqual([a]);
    expect(due(db, T0 + 60_000).map((r) => r.id)).toEqual([a, b]);
    markDelivered(db, a);
    expect(due(db, T0 + 60_000).map((r) => r.id)).toEqual([b]);
    db.close();
  });
});

describe("退避策略", () => {
  it("30s 起 ×2 封顶 1h", () => {
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(2)).toBe(60_000);
    expect(backoffFor(3)).toBe(120_000);
    expect(backoffFor(7)).toBe(1_920_000);
    expect(backoffFor(8)).toBe(RETRY_MAX_MS);
    expect(backoffFor(50)).toBe(RETRY_MAX_MS);
  });
});

describe("markAttempt", () => {
  it("attempts+1、记录 last_error、next_retry_at 更新", () => {
    const db = freshDb();
    const id = enqueue(db, req(), T0);
    markAttempt(db, id, "ECONNREFUSED", T0 + 30_000);
    const row = get(db, id)!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("ECONNREFUSED");
    expect(row.next_retry_at).toBe(T0 + 30_000);
    expect(row.state).toBe("queued");
    db.close();
  });

  it("markAttemptWithBackoff 依 attempts 递增退避", () => {
    const db = freshDb();
    const id = enqueue(db, req(), T0);
    expect(markAttemptWithBackoff(db, id, "e1", T0)).toBe(T0 + 30_000);
    expect(markAttemptWithBackoff(db, id, "e2", T0)).toBe(T0 + 60_000);
    expect(markAttemptWithBackoff(db, id, "e3", T0)).toBe(T0 + 120_000);
    expect(get(db, id)!.attempts).toBe(3);
    db.close();
  });
});

describe("状态机全转移", () => {
  it("queued →（重试退避循环）→ delivered；queued → expired（72h 超时）", () => {
    const db = freshDb();
    const id = enqueue(db, req(), T0);
    // queued → 重试若干轮
    markAttemptWithBackoff(db, id, "e1", T0);
    expect(get(db, id)!.state).toBe("queued");
    // delivered 转移
    markDelivered(db, id);
    expect(get(db, id)!.state).toBe("delivered");
    expect(due(db, T0 + 10 ** 9)).toHaveLength(0);
    // 72h 超时转移
    const stale = enqueue(db, req(), T0);
    const expired = expireDue(db, T0 + 72 * 3_600_000 + 1);
    expect(expired.map((r) => r.id)).toEqual([stale]);
    expect(get(db, stale)!.state).toBe("expired");
    // 未超时的不受影响
    const fresh = enqueue(db, req(), T0 + 72 * 3_600_000 + 1);
    expect(expireDue(db, T0 + 72 * 3_600_000 + 2)).toHaveLength(0);
    expect(get(db, fresh)!.state).toBe("queued");
    db.close();
  });

  it("delivered/expired 不再出现在 due 与 expireDue 中", () => {
    const db = freshDb();
    const a = enqueue(db, req(), T0);
    const b = enqueue(db, req(), T0);
    markDelivered(db, a);
    expireDue(db, T0 + 72 * 3_600_000 + 1);
    expect(due(db, T0 + 10 ** 9).map((r) => r.id)).toEqual([]);
    expect(expireDue(db, T0 + 10 ** 9).map((r) => r.id)).toEqual([]);
    expect(get(db, b)!.state).toBe("expired");
    db.close();
  });
});

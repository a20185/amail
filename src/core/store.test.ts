import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverReq } from "../contract/api.js";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openStore } from "./db.js";
import { get, listInbox, markArchived, markRead, saveInbound, saveLocalNotice, saveOutbound, search, threadOf } from "./store.js";
import { get as getOutbox } from "./outbox.js";
import type { Envelope } from "../contract/envelope.js";

function freshDb(): DatabaseSync {
  return openStore(join(mkdtempSync(join(tmpdir(), "amail-store-")), "store.db"));
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
    from: "alice@mbp16",
    to: "bob@thinkpadx1",
    subject: "审查契约门",
    inReplyTo: null,
    references: [],
    createdAt: "2026-10-27T09:00:00.000Z",
    claim: { name: "Alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm", epk: "ZXBk", iv: "aXY=", body: "Y2lwaGVy" },
    attachments: [],
    sig: "c2ln",
    ...overrides,
  };
}

function deliverReq(env: Envelope): DeliverReq {
  return { envelope: env, parts: [] };
}

describe("saveInbound", () => {
  it("落库 direction=in、opened 的 body/handoff 与附件 blob 路径", () => {
    const db = freshDb();
    const env = envelope({
      attachments: [
        { id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM", name: "progress.md", sha256: "a".repeat(64), size: 12 },
      ],
    });
    saveInbound(db, env, {
      body: "契约门正文",
      handoffJson: '{"progress":"p","description":"d","questions":["q"]}',
      attachments: [{ id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM", blobPath: "/blobs/aa/att1" }],
    }, { sigValid: true });
    const row = get(db, env.id);
    expect(row?.direction).toBe("in");
    expect(row?.body).toBe("契约门正文");
    expect(row?.handoff_json).toContain("progress");
    expect(row?.sig_valid).toBe(1);
    expect(row?.received_at).toBeTruthy();
    const att = db.prepare("SELECT * FROM attachments WHERE message_id = ?").all(env.id) as Array<{
      blob_path: string;
      name: string;
    }>;
    expect(att).toHaveLength(1);
    expect(att[0]!.blob_path).toBe("/blobs/aa/att1");
    expect(att[0]!.name).toBe("progress.md");
    db.close();
  });

  it("thread_root：回复信挂到根信线程", () => {
    const db = freshDb();
    const root = envelope();
    saveInbound(db, root, { body: "root", attachments: [] }, { sigValid: true });
    const reply = envelope({
      id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEN",
      inReplyTo: root.id,
      references: [root.id],
    });
    saveInbound(db, reply, { body: "reply", attachments: [] }, { sigValid: false });
    expect(get(db, reply.id)?.thread_root).toBe(root.id);
    expect(get(db, reply.id)?.sig_valid).toBe(0);
    db.close();
  });
});

describe("saveOutbound", () => {
  it("单事务落 messages(out，正文取 localCopy) + outbox.enqueue（payload=DeliverReq 完整序列化）", () => {
    const db = freshDb();
    const env = envelope();
    const { outboxId } = saveOutbound(db, deliverReq(env), { body: "发出的明文正文" });
    const row = get(db, env.id);
    expect(row?.direction).toBe("out");
    expect(row?.body).toBe("发出的明文正文");
    const ob = getOutbox(db, outboxId)!;
    expect(ob.state).toBe("queued");
    expect(ob.attempts).toBe(0);
    expect(JSON.parse(ob.payload_json)).toEqual(deliverReq(env));
    db.close();
  });

  it("附件 parts 同事务落库", () => {
    const db = freshDb();
    const env = envelope({
      attachments: [
        { id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM", name: "a.md", sha256: "b".repeat(64), size: 5 },
      ],
    });
    saveOutbound(
      db,
      { envelope: env, parts: [{ id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM", seal: env.seal }] },
      { body: "x" },
    );
    expect(db.prepare("SELECT COUNT(*) c FROM attachments").get()).toEqual({ c: 1 });
    db.close();
  });
});

describe("listInbox / markRead / markArchived", () => {
  it("默认只列未归档；all 含归档；unread 过滤未读；project 过滤项目", () => {
    const db = freshDb();
    const m1 = envelope({ id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEM", subject: "1", createdAt: "2026-10-27T09:00:01.000Z" });
    const m2 = envelope({ id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEN", subject: "2", createdAt: "2026-10-27T09:00:02.000Z" });
    const m3 = envelope({ id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEP", subject: "3", createdAt: "2026-10-27T09:00:03.000Z" });
    for (const m of [m1, m2, m3]) saveInbound(db, m, { body: "b", attachments: [] }, { sigValid: true });
    markRead(db, m1.id);
    markArchived(db, m2.id, "proj-x");
    expect(listInbox(db).map((r) => r.id)).toEqual([m3.id, m1.id]);
    expect(listInbox(db, { unread: true }).map((r) => r.id)).toEqual([m3.id]);
    expect(listInbox(db, { all: true })).toHaveLength(3);
    expect(listInbox(db, { project: "proj-x", all: true }).map((r) => r.id)).toEqual([m2.id]);
    db.close();
  });

  it("markRead 返回是否发生 空→已读 转移（首次门槛）", () => {
    const db = freshDb();
    const env = envelope();
    saveInbound(db, env, { body: "b", attachments: [] }, { sigValid: true });
    expect(markRead(db, env.id)).toBe(true);
    expect(markRead(db, env.id)).toBe(false);
    expect(markRead(db, "msg_missing0000000000000000")).toBe(false);
    db.close();
  });
});

describe("saveLocalNotice", () => {
  it("本机通知信：direction=in 且不入出箱", () => {
    const db = freshDb();
    const id = saveLocalNotice(db, "alice@mbp16", "本地通知", "房主被 CC");
    const row = get(db, id);
    expect(row?.direction).toBe("in");
    expect(row?.body).toBe("房主被 CC");
    expect(db.prepare("SELECT COUNT(*) c FROM outbox").get()).toEqual({ c: 0 });
    db.close();
  });
});

describe("search 中文检索", () => {
  it("≥3 字走 FTS trigram：「契约门」子串命中", () => {
    const db = freshDb();
    saveInbound(db, envelope(), { body: "请审查契约门后的验收标准", attachments: [] }, { sigValid: true });
    const hits = search(db, "契约门");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toContain("契约门");
    expect(search(db, "契约门后")).toHaveLength(1);
    expect(search(db, "不存在的词组")).toHaveLength(0);
    db.close();
  });

  it("短词 LIKE 兜底：「结算」两字也能命中", () => {
    const db = freshDb();
    saveInbound(db, envelope(), { body: "本周结算已完成", attachments: [] }, { sigValid: true });
    const hits = search(db, "结算");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toContain("结算");
    db.close();
  });
});

describe("threadOf", () => {
  it("按 thread_root 聚合整条线程", () => {
    const db = freshDb();
    const root = envelope();
    const reply = envelope({ id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEN", inReplyTo: root.id, references: [root.id] });
    const r2 = envelope({ id: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEP", inReplyTo: reply.id, references: [root.id, reply.id] });
    for (const m of [root, reply, r2]) saveInbound(db, m, { body: "b", attachments: [] }, { sigValid: true });
    expect(threadOf(db, r2.id).map((r) => r.id)).toEqual([root.id, reply.id, r2.id]);
    expect(threadOf(db, "msg_nope0000000000000000000")).toEqual([]);
    db.close();
  });
});

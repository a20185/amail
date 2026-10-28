import { describe, expect, it } from "vitest";
import {
  AliveInfoSchema,
  DeliverReqSchema,
  InboxQuerySchema,
  MirrorEventSchema,
  RawMirrorEventSchema,
  SendMessageReqSchema,
  WorkspaceSyncQuerySchema,
} from "./api.js";

const envelope = {
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

describe("AliveInfoSchema", () => {
  it("round-trips", () => {
    const info = {
      user: "alice@mbp16",
      deviceName: "mbp16",
      fingerprint: "0123456789abcdef",
      version: "0.0.1",
      pairedCount: 2,
    };
    expect(AliveInfoSchema.parse(info)).toEqual(info);
  });
  it.each([
    ["missing fingerprint", { user: "a@b", deviceName: "d", version: "1", pairedCount: 0 }],
    ["bad fingerprint", { user: "a@b", deviceName: "d", fingerprint: "zz", version: "1", pairedCount: 0 }],
    ["bad pairedCount", { user: "a@b", deviceName: "d", fingerprint: "0123456789abcdef", version: "1", pairedCount: -1 }],
    ["missing user", { deviceName: "d", fingerprint: "0123456789abcdef", version: "1", pairedCount: 0 }],
  ])("rejects %s", (_l, bad) => {
    expect(() => AliveInfoSchema.parse(bad)).toThrow();
  });
});

describe("InboxQuerySchema", () => {
  it("accepts all optional", () => {
    expect(InboxQuerySchema.parse({})).toEqual({});
    expect(InboxQuerySchema.parse({ project: "demo", unread: true })).toEqual({
      project: "demo",
      unread: true,
    });
  });
  it.each([
    ["bad unread", { unread: "yes" }],
    ["bad project", { project: 1 }],
    ["bad all", { all: 1 }],
  ])("rejects %s", (_l, bad) => {
    expect(() => InboxQuerySchema.parse(bad)).toThrow();
  });
});

describe("SendMessageReqSchema", () => {
  const req = {
    to: "bob@thinkpadx1",
    subject: "s",
    body: "hello",
    refs: [],
  };
  it("round-trips", () => {
    expect(SendMessageReqSchema.parse(req)).toEqual(req);
  });
  it.each([
    ["missing to", { ...req, to: undefined }],
    ["bad to", { ...req, to: "bob" }],
    ["body too long", { ...req, body: "x".repeat(4001) }],
    ["missing refs", { ...req, refs: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => SendMessageReqSchema.parse(bad)).toThrow();
  });
});

describe("DeliverReqSchema", () => {
  it("round-trips", () => {
    const req = {
      envelope,
      parts: [
        {
          id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
          seal: { alg: "x25519-aes256gcm", epk: "ZXBk", iv: "aXY=", body: "Y2k=" },
        },
      ],
    };
    expect(DeliverReqSchema.parse(req)).toEqual(req);
  });
  it.each([
    ["missing parts", { envelope, parts: undefined }],
    ["part missing seal", { envelope, parts: [{ id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM" }] }],
    ["bad envelope", { envelope: { ...envelope, v: 3 }, parts: [] }],
    ["part bad id", { envelope, parts: [{ id: "x", seal: envelope.seal }] }],
  ])("rejects %s", (_l, bad) => {
    expect(() => DeliverReqSchema.parse(bad)).toThrow();
  });
});

describe("WorkspaceSyncQuerySchema", () => {
  it("round-trips", () => {
    expect(WorkspaceSyncQuerySchema.parse({ since: 42 })).toEqual({ since: 42 });
  });
  it.each([
    ["missing since", {}],
    ["bad since", { since: "42" }],
    ["negative since", { since: -1 }],
    ["extra ok but wrong type", { since: 1.5 }],
  ])("rejects %s", (_l, bad) => {
    expect(() => WorkspaceSyncQuerySchema.parse(bad)).toThrow();
  });
});

describe("RawMirrorEventSchema / MirrorEventSchema", () => {
  const raw = {
    t: "2026-10-27T09:00:00.000Z",
    sessionId: "s1",
    role: "assistant",
    text: "hello",
  };
  it("round-trips raw", () => {
    expect(RawMirrorEventSchema.parse(raw)).toEqual(raw);
  });
  it("round-trips mirror with n", () => {
    expect(MirrorEventSchema.parse({ ...raw, n: 7 })).toEqual({ ...raw, n: 7 });
  });
  it.each([
    ["raw missing sessionId", RawMirrorEventSchema, { t: raw.t }],
    ["raw bad t", RawMirrorEventSchema, { ...raw, t: 123 }],
    ["mirror missing n", MirrorEventSchema, raw],
    ["mirror bad n", MirrorEventSchema, { ...raw, n: "7" }],
  ] as const)("rejects %s", (_l, schema, bad) => {
    expect(() => schema.parse(bad)).toThrow();
  });
});

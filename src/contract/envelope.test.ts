import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  EnvelopeSchema,
  HandoffSchema,
  SealedBodySchema,
} from "./envelope.js";

const handoff = {
  progress: "half done",
  description: "implemented contracts",
  questions: ["next step?"],
};

const sealedBody = {
  body: "please review",
  handoff,
  attachmentIds: ["att_01JD2YWBN5GQXJSQ9P7RJ3TBEM"],
};

const envelope = {
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
  attachments: [
    {
      id: "att_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
      name: "progress.md",
      sha256: "a".repeat(64),
      size: 1234,
    },
  ],
  sig: "c2ln",
};

describe("HandoffSchema", () => {
  it("round-trips", () => {
    expect(HandoffSchema.parse(handoff)).toEqual(handoff);
  });
  it.each([
    ["missing questions", { progress: "p", description: "d" }],
    [
      "too many questions",
      { progress: "p", description: "d", questions: Array(11).fill("q") },
    ],
    ["empty questions", { progress: "p", description: "d", questions: [] }],
    ["progress too long", { ...handoff, progress: "x".repeat(2001) }],
  ])("rejects %s", (_l, bad) => {
    expect(() => HandoffSchema.parse(bad)).toThrow();
  });
});

describe("SealedBodySchema", () => {
  it("round-trips", () => {
    expect(SealedBodySchema.parse(sealedBody)).toEqual(sealedBody);
  });
  it.each([
    ["missing body", { ...sealedBody, body: undefined }],
    ["missing attachmentIds", { ...sealedBody, attachmentIds: undefined }],
    ["wrong attachmentIds type", { ...sealedBody, attachmentIds: "att_x" }],
    ["wrong handoff type", { ...sealedBody, handoff: "see above" }],
  ])("rejects %s", (_l, bad) => {
    expect(() => SealedBodySchema.parse(bad)).toThrow();
  });
});

describe("EnvelopeSchema", () => {
  it("round-trips parse → canonicalJson → parse", () => {
    const once = EnvelopeSchema.parse(envelope);
    const text = canonicalJson(once, EnvelopeSchema);
    expect(text).not.toMatch(/\s/);
    const twice = EnvelopeSchema.parse(JSON.parse(text));
    expect(twice).toEqual(once);
  });

  it("keeps zod declaration key order in canonicalJson", () => {
    const text = canonicalJson(envelope, EnvelopeSchema);
    expect(text.startsWith('{"v":1,"id":"msg_')).toBe(true);
  });

  it.each([
    ["missing subject", { ...envelope, subject: undefined }],
    ["wrong v", { ...envelope, v: 2 }],
    ["bad from", { ...envelope, from: "not-an-address" }],
    ["missing seal", { ...envelope, seal: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => EnvelopeSchema.parse(bad)).toThrow();
  });

  it("rejects inReplyTo not present in references", () => {
    expect(() =>
      EnvelopeSchema.parse({
        ...envelope,
        inReplyTo: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
        references: ["msg_0OTHER"],
      }),
    ).toThrow();
  });

  it("rejects negative attachment size", () => {
    expect(() =>
      EnvelopeSchema.parse({
        ...envelope,
        attachments: [{ ...envelope.attachments[0]!, size: -1 }],
      }),
    ).toThrow();
  });
});

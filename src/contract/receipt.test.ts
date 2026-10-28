import { describe, expect, it } from "vitest";
import { ReceiptSchema } from "./receipt.js";

const receipt = {
  messageId: "msg_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
  kind: "read",
  at: "2026-10-27T10:00:00.000Z",
  sig: "c2ln",
};

describe("ReceiptSchema", () => {
  it("round-trips", () => {
    expect(ReceiptSchema.parse(receipt)).toEqual(receipt);
  });
  it.each([
    ["missing sig", { ...receipt, sig: undefined }],
    ["bad kind", { ...receipt, kind: "seen" }],
    ["bad at", { ...receipt, at: "now" }],
    ["bad messageId", { ...receipt, messageId: 1 }],
  ])("rejects %s", (_l, bad) => {
    expect(() => ReceiptSchema.parse(bad)).toThrow();
  });
});

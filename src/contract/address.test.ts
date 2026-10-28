import { describe, expect, it } from "vitest";
import { AddressSchema, formatAddress, parseAddress } from "./address.js";

describe("AddressSchema", () => {
  it("accepts user@device", () => {
    expect(AddressSchema.parse("alice@mbp16")).toBe("alice@mbp16");
  });

  it("round-trips parse/format", () => {
    const parsed = parseAddress("bob@thinkpadx1");
    expect(parsed).toEqual({ user: "bob", device: "thinkpadx1" });
    expect(formatAddress(parsed)).toBe("bob@thinkpadx1");
  });

  it.each([
    ["missing device", "alice@"],
    ["missing user", "@mbp16"],
    ["double @", "alice@foo@bar"],
    ["space", "ali ce@mbp16"],
    ["empty", ""],
    ["wrong type", 42],
  ])("rejects %s", (_label, bad) => {
    expect(() => AddressSchema.parse(bad)).toThrow();
  });
});

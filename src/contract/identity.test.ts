import { describe, expect, it } from "vitest";
import {
  DeviceIdentitySchema,
  PeerRecordSchema,
  UserClaimSchema,
} from "./identity.js";

const claim = { name: "Alice", email: "alice@example.com" };
const deviceId = "0123456789abcdef";
const pem = "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n";

const identity = {
  deviceId,
  deviceName: "mbp16",
  claim,
  signPubKeyPem: pem,
  encPubKeyPem: pem,
};

const peer = {
  deviceId,
  deviceName: "thinkpadx1",
  user: "Bob",
  device: "thinkpadx1",
  claim: { name: "Bob", email: "bob@example.com" },
  signPubKeyPem: pem,
  encPubKeyPem: pem,
  pairedAt: "2026-10-27T09:00:00.000Z",
  revokedAt: null,
};

describe("UserClaimSchema", () => {
  it("round-trips", () => {
    expect(UserClaimSchema.parse(claim)).toEqual(claim);
  });
  it.each([
    ["missing email", { name: "Alice" }],
    ["bad email", { name: "Alice", email: "not-an-email" }],
    ["empty name", { name: "", email: "a@b.c" }],
    ["wrong type", "Alice"],
  ])("rejects %s", (_l, bad) => {
    expect(() => UserClaimSchema.parse(bad)).toThrow();
  });
});

describe("DeviceIdentitySchema", () => {
  it("round-trips", () => {
    expect(DeviceIdentitySchema.parse(identity)).toEqual(identity);
  });
  it.each([
    ["missing encPubKeyPem", { ...identity, encPubKeyPem: undefined }],
    ["bad deviceId", { ...identity, deviceId: "zzz" }],
    ["wrong deviceId type", { ...identity, deviceId: 42 }],
    ["missing claim", { ...identity, claim: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => DeviceIdentitySchema.parse(bad)).toThrow();
  });
});

describe("PeerRecordSchema", () => {
  it("round-trips", () => {
    expect(PeerRecordSchema.parse(peer)).toEqual(peer);
  });
  it("accepts revoked ISO", () => {
    expect(
      PeerRecordSchema.parse({ ...peer, revokedAt: "2026-10-28T00:00:00.000Z" })
        .revokedAt,
    ).toBe("2026-10-28T00:00:00.000Z");
  });
  it.each([
    ["missing user", { ...peer, user: undefined }],
    ["bad revokedAt", { ...peer, revokedAt: "yesterday" }],
    ["wrong pairedAt type", { ...peer, pairedAt: 1761540000 }],
    ["missing device field", { ...peer, device: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => PeerRecordSchema.parse(bad)).toThrow();
  });
});

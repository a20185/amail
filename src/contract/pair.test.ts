import { describe, expect, it } from "vitest";
import {
  PairAnswerSchema,
  PairConfirmSigSchema,
  PairOfferSchema,
} from "./pair.js";

const deviceId = "0123456789abcdef";
const pem = "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n";
const claim = { name: "Alice", email: "alice@example.com" };

const offer = {
  deviceId,
  deviceName: "mbp16",
  claim,
  signPubKeyPem: pem,
  encPubKeyPem: pem,
  nonce: "nonceA",
  sig: "c2lnQQ==",
};

const answer = {
  deviceId: "fedcba9876543210",
  deviceName: "thinkpadx1",
  claim: { name: "Bob", email: "bob@example.com" },
  signPubKeyPem: pem,
  encPubKeyPem: pem,
  nonce: "nonceB",
  offerNonce: "nonceA",
  sig: "c2lnQg==",
};

const confirmSig = {
  offerNonce: "nonceA",
  answerNonce: "nonceB",
  deviceIdA: deviceId,
  deviceIdB: "fedcba9876543210",
  sig: "c2lnQw==",
};

describe("PairOfferSchema", () => {
  it("round-trips", () => {
    expect(PairOfferSchema.parse(offer)).toEqual(offer);
  });
  it.each([
    ["missing nonce", { ...offer, nonce: undefined }],
    ["missing sig", { ...offer, sig: undefined }],
    ["bad deviceId", { ...offer, deviceId: "zz" }],
    ["missing encPubKeyPem", { ...offer, encPubKeyPem: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => PairOfferSchema.parse(bad)).toThrow();
  });
});

describe("PairAnswerSchema", () => {
  it("round-trips", () => {
    expect(PairAnswerSchema.parse(answer)).toEqual(answer);
  });
  it.each([
    ["missing offerNonce", { ...answer, offerNonce: undefined }],
    ["missing nonce", { ...answer, nonce: undefined }],
    ["bad claim", { ...answer, claim: "Bob" }],
    ["missing sig", { ...answer, sig: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => PairAnswerSchema.parse(bad)).toThrow();
  });
});

describe("PairConfirmSigSchema", () => {
  it("round-trips", () => {
    expect(PairConfirmSigSchema.parse(confirmSig)).toEqual(confirmSig);
  });
  it.each([
    ["missing deviceIdA", { ...confirmSig, deviceIdA: undefined }],
    ["missing deviceIdB", { ...confirmSig, deviceIdB: undefined }],
    ["bad sig type", { ...confirmSig, sig: 1 }],
    ["missing answerNonce", { ...confirmSig, answerNonce: undefined }],
  ])("rejects %s", (_l, bad) => {
    expect(() => PairConfirmSigSchema.parse(bad)).toThrow();
  });
});

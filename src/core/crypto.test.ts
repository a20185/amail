import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalStringify,
  openBody,
  sas6,
  sealBody,
  sha256Hex,
  signCanonical,
  verifyCanonical,
} from "./crypto.js";

const alice = generateKeyPairSync("x25519");
const bob = generateKeyPairSync("x25519");
const bobPubPem = bob.publicKey.export({ type: "spki", format: "pem" }).toString();
const bobPrivPem = bob.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const sigA = generateKeyPairSync("ed25519");
const sigAPubPem = sigA.publicKey.export({ type: "spki", format: "pem" }).toString();
const sigAPrivPem = sigA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("sealBody / openBody", () => {
  it("round-trip：密封后可由收件方 X25519 私钥解出原文", () => {
    const plain = Buffer.from("你好，契约门后的正文");
    const seal = sealBody(bobPubPem, plain);
    expect(seal.alg).toBe("x25519-aes256gcm");
    expect(openBody(bobPrivPem, seal).toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("篡改密文失败：GCM 认证标签校验不通过", () => {
    const seal = sealBody(bobPubPem, Buffer.from("secret"));
    const buf = Buffer.from(seal.body, "base64");
    buf[0]! ^= 0xff;
    const tampered = { ...seal, body: buf.toString("base64") };
    expect(() => openBody(bobPrivPem, tampered)).toThrow();
  });

  it("非收件方私钥无法解封", () => {
    const seal = sealBody(bobPubPem, Buffer.from("secret"));
    const alicePrivPem = alice.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => openBody(alicePrivPem, seal)).toThrow();
  });

  it("每次密封使用新的 ephemeral 公钥与 iv", () => {
    const a = sealBody(bobPubPem, Buffer.from("x"));
    const b = sealBody(bobPubPem, Buffer.from("x"));
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe("signCanonical / verifyCanonical", () => {
  it("round-trip：Ed25519 对规范 JSON 签名可验签", () => {
    const obj = { b: 1, a: "两", c: [3, { z: null, y: true }] };
    const sig = signCanonical(sigAPrivPem, obj);
    expect(verifyCanonical(sigAPubPem, obj, sig)).toBe(true);
  });

  it("键序不同但内容相同的对象验签通过（规范化生效）", () => {
    const sig = signCanonical(sigAPrivPem, { a: 1, b: 2 });
    expect(verifyCanonical(sigAPubPem, { b: 2, a: 1 }, sig)).toBe(true);
  });

  it("篡改对象验签失败", () => {
    const sig = signCanonical(sigAPrivPem, { a: 1 });
    expect(verifyCanonical(sigAPubPem, { a: 2 }, sig)).toBe(false);
  });

  it("canonicalStringify 键按字典序且无空白", () => {
    expect(canonicalStringify({ z: 1, a: [2, { y: "x" }] })).toBe('{"a":[2,{"y":"x"}],"z":1}');
  });
});

describe("sha256Hex", () => {
  it("输出 64 位小写十六进制", () => {
    expect(sha256Hex(Buffer.from("abc"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sas6", () => {
  it("对称：双方以任意顺序计算得到相同 6 位十进制短码", () => {
    const pubA = Buffer.alloc(32, 1);
    const pubB = Buffer.alloc(32, 2);
    expect(sas6(pubA, pubB)).toBe(sas6(pubB, pubA));
    expect(sas6(pubA, pubB)).toMatch(/^[0-9]{6}$/);
  });

  it("不同公钥组合得到不同短码（概率上）", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const c = Buffer.alloc(32, 3);
    expect(sas6(a, b)).not.toBe(sas6(a, c));
  });
});

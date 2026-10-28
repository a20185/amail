import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { Seal } from "../contract/envelope.js";

const HKDF_INFO = "amail/x25519-aes256gcm";
const IV_LEN = 12;

/** 规范 JSON：键按字典序，无空白 —— 签名/验签的字节基础 */
export function canonicalStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort(obj[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(sort(value));
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 导出公钥原始 32B（spki 尾部） */
export function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

/** 导出私钥原始 32B（pkcs8 尾部） */
export function rawPrivateKey(priv: KeyObject): Buffer {
  const der = priv.export({ type: "pkcs8", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

/** 由 32B 种子构造 Ed25519 / X25519 密钥对 */
export function keyPairFromSeed(curve: "ed25519" | "x25519", seed: Buffer) {
  const oid = curve === "ed25519" ? "2b6570" : "2b656e";
  const pkcs8 = Buffer.concat([
    Buffer.from(`302e02010030050603${oid}04220420`, "hex"),
    seed,
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv);
  return { priv, pub };
}

/**
 * 密封：ephemeral X25519 + HKDF 派生 AES-256-GCM 密钥 + 12B iv。
 * 加密一律用对端 X25519 公钥；签名用 Ed25519，两者不可互换。
 */
export function sealBody(recipientEncPubPem: string, plainBuf: Buffer): Seal {
  const recipientPub = createPublicKey(recipientEncPubPem);
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const iv = randomBytes(IV_LEN);
  const key = Buffer.from(hkdfSync("sha256", shared, iv, Buffer.from(HKDF_INFO), 32));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(plainBuf), cipher.final(), cipher.getAuthTag()]);
  return {
    alg: "x25519-aes256gcm",
    epk: rawPublicKey(eph.publicKey).toString("base64"),
    iv: iv.toString("base64"),
    body: sealed.toString("base64"),
  };
}

export function openBody(encPrivPem: string, seal: Seal): Buffer {
  const priv = createPrivateKey(encPrivPem);
  const ephPub = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.from(seal.epk, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: priv, publicKey: ephPub });
  const iv = Buffer.from(seal.iv, "base64");
  const key = Buffer.from(hkdfSync("sha256", shared, iv, Buffer.from(HKDF_INFO), 32));
  const data = Buffer.from(seal.body, "base64");
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Ed25519 签名（对规范 JSON 字节） */
export function signCanonical(privPem: string, obj: unknown): string {
  const priv = createPrivateKey(privPem);
  return cryptoSign(null, Buffer.from(canonicalStringify(obj)), priv).toString("base64");
}

export function verifyCanonical(pubPem: string, obj: unknown, sig: string): boolean {
  try {
    const pub = createPublicKey(pubPem);
    return cryptoVerify(null, Buffer.from(canonicalStringify(obj)), pub, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/** SAS：sha256(min‖max 规范字节) 前 20bit → 6 位十进制，双方一致 */
export function sas6(pubA: Buffer, pubB: Buffer): string {
  const [min, max] = pubA.compare(pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const digest = createHash("sha256").update(Buffer.concat([min, max])).digest();
  const value = (digest.readUInt32BE(0) >>> 12) % 1_000_000;
  return value.toString().padStart(6, "0");
}

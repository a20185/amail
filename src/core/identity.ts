import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createPublicKey } from "node:crypto";
import {
  canonicalStringify,
  keyPairFromSeed,
  rawPublicKey,
  signCanonical,
} from "./crypto.js";
import type { UserClaim } from "../contract/identity.js";
import type { Dirs } from "./paths.js";

const SEED_FILE = "device.pem";

export interface DeviceIdentityFull {
  /** sha256(signPub) 前 16hex */
  deviceId: string;
  deviceName: string;
  signPrivPem: string;
  encPrivPem: string;
  signPubPem: string;
  encPubPem: string;
}

export function fingerprint(signPubPem: string): string {
  const raw = rawPublicKey(createPublicKey(signPubPem));
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function deviceName(): string {
  return hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "device";
}

/**
 * 单一 32B 种子落 keys/device.pem（0600），派生 Ed25519（签名）与 X25519（加密）两对密钥。
 */
export function loadOrCreateIdentity(dirs: Dirs): DeviceIdentityFull {
  const seedPath = join(dirs.keysDir, SEED_FILE);
  let seed: Buffer;
  if (existsSync(seedPath)) {
    seed = Buffer.from(readFileSync(seedPath, "utf8").trim(), "hex");
    if (seed.length !== 32) throw new Error(`corrupt device seed at ${seedPath}`);
  } else {
    seed = randomBytes(32);
    writeFileSync(seedPath, seed.toString("hex") + "\n", { mode: 0o600 });
    chmodSync(seedPath, 0o600);
  }

  const sign = keyPairFromSeed("ed25519", seed);
  const enc = keyPairFromSeed("x25519", seed);
  const signPubPem = sign.pub.export({ type: "spki", format: "pem" }).toString();
  const encPubPem = enc.pub.export({ type: "spki", format: "pem" }).toString();
  const signPrivPem = sign.priv.export({ type: "pkcs8", format: "pem" }).toString();
  const encPrivPem = enc.priv.export({ type: "pkcs8", format: "pem" }).toString();

  return {
    deviceId: fingerprint(signPubPem),
    deviceName: deviceName(),
    signPrivPem,
    encPrivPem,
    signPubPem,
    encPubPem,
  };
}

/** 签名自声明：claim + 对 claim 规范字节的设备签名 */
export function buildClaim(
  signPrivPem: string,
  name: string,
  email: string,
): { claim: UserClaim; sig: string; canonical: string } {
  const claim: UserClaim = { name, email };
  const canonical = canonicalStringify(claim);
  const sig = signCanonical(signPrivPem, claim);
  return { claim, sig, canonical };
}

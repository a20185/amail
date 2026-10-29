import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyPairFromSeed, openBody, sealBody, signCanonical, verifyCanonical } from "./crypto.js";
import { resolveDirs } from "./paths.js";
import { buildClaim, deviceName, fingerprint, loadOrCreateIdentity } from "./identity.js";

function sandboxDirs() {
  return resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-id-")) });
}

describe("loadOrCreateIdentity", () => {
  it("派生 Ed25519（签名）与 X25519（加密）两对密钥，两把公钥 PEM 不同", () => {
    const id = loadOrCreateIdentity(sandboxDirs());
    expect(id.signPubPem).toMatch(/BEGIN PUBLIC KEY/);
    expect(id.encPubPem).toMatch(/BEGIN PUBLIC KEY/);
    expect(id.signPubPem).not.toBe(id.encPubPem);
  });

  it("种子落 keys/device.pem，权限 0600，内容为 32B hex", () => {
    const dirs = sandboxDirs();
    loadOrCreateIdentity(dirs);
    const seedPath = join(dirs.keysDir, "device.pem");
    const seed = readFileSync(seedPath, "utf8").trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(seedPath).mode & 0o777).toBe(0o600);
  });

  it("同一目录重复加载得到完全相同身份（幂等）", () => {
    const dirs = sandboxDirs();
    const a = loadOrCreateIdentity(dirs);
    const b = loadOrCreateIdentity(dirs);
    expect(a).toEqual(b);
  });

  it("不同种子得到不同 deviceId 与公钥", () => {
    const a = loadOrCreateIdentity(sandboxDirs());
    const b = loadOrCreateIdentity(sandboxDirs());
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.signPubPem).not.toBe(b.signPubPem);
  });

  it("deviceId = sha256(signPub) 前 16hex（同一 signPub → 同一指纹）", () => {
    const id = loadOrCreateIdentity(sandboxDirs());
    expect(id.deviceId).toBe(fingerprint(id.signPubPem));
    expect(id.deviceId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("密钥可实际使用：signPub 可验 Ed25519 签名，encPub 可被 sealBody 定向", () => {
    const id = loadOrCreateIdentity(sandboxDirs());
    expect(verifyCanonical(id.signPubPem, { x: 1 }, signCanonical(id.signPrivPem, { x: 1 }))).toBe(true);
    const seal = sealBody(id.encPubPem, Buffer.from("hi"));
    expect(openBody(id.encPrivPem, seal).toString()).toBe("hi");
  });
});

describe("deviceName", () => {
  it("返回非空、去非法字符的 hostname", () => {
    expect(deviceName()).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("buildClaim", () => {
  it("签名自声明：claim 可被同设备公钥验签", () => {
    const id = loadOrCreateIdentity(sandboxDirs());
    const { claim, sig } = buildClaim(id.signPrivPem, "Alice", "alice@example.com");
    expect(claim).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(verifyCanonical(id.signPubPem, claim, sig)).toBe(true);
  });
});

describe("keyPairFromSeed", () => {
  it("同一种子派生出相同公钥（两台设备各自从种子恢复一致）", () => {
    const seed = Buffer.alloc(32, 7);
    const a = keyPairFromSeed("ed25519", seed);
    const b = keyPairFromSeed("ed25519", seed);
    expect(a.pub.export({ type: "spki", format: "der" })).toEqual(
      b.pub.export({ type: "spki", format: "der" }),
    );
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDirs, type Dirs } from "./paths.js";
import { openStore } from "./db.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "./identity.js";
import type { PeerRecord } from "../contract/identity.js";
import {
  getPeerByAddress,
  getPeerByDeviceId,
  isPaired,
  listPeers,
  revokePeer,
  savePeer,
} from "./peer.js";

function setup(): { db: ReturnType<typeof openStore>; peer: (n: number) => PeerRecord } {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-peer-")) });
  const db = openStore(dirs.storePath);
  const identities: DeviceIdentityFull[] = [];
  const peer = (n: number): PeerRecord => {
    if (!identities[n]) {
      const home = mkdtempSync(join(tmpdir(), `amail-peer-id${n}-`));
      identities[n] = loadOrCreateIdentity(resolveDirs({ AMAIL_HOME: home }) as Dirs);
    }
    const id = identities[n]!;
    return {
      deviceId: id.deviceId,
      deviceName: id.deviceName,
      user: `bob${n}`,
      device: id.deviceName,
      claim: { name: `Bob ${n}`, email: `bob${n}@example.com` },
      signPubKeyPem: id.signPubPem,
      encPubKeyPem: id.encPubPem,
      pairedAt: new Date().toISOString(),
      revokedAt: null,
    };
  };
  return { db, peer };
}

describe("peer CRUD", () => {
  it("savePeer 落盘含双公钥；isPaired/getPeerByAddress 命中", () => {
    const { db, peer } = setup();
    const record = peer(0);
    savePeer(db, record);
    expect(isPaired(db, `${record.user}@${record.device}`)).toBe(true);
    const found = getPeerByAddress(db, `${record.user}@${record.device}`);
    expect(found?.deviceId).toBe(record.deviceId);
    expect(found?.signPubKeyPem).toBe(record.signPubKeyPem);
    expect(found?.encPubKeyPem).toBe(record.encPubKeyPem);
    expect(getPeerByDeviceId(db, record.deviceId)?.user).toBe(record.user);
  });

  it("未配对地址 isPaired=false；getPeerByAddress undefined", () => {
    const { db } = setup();
    expect(isPaired(db, "stranger@dev")).toBe(false);
    expect(getPeerByAddress(db, "stranger@dev")).toBeUndefined();
  });

  it("revokePeer 后拒收：isPaired=false、listPeers 默认不含；重复 revoke 返回 false", () => {
    const { db, peer } = setup();
    const record = peer(1);
    savePeer(db, record);
    const addr = `${record.user}@${record.device}`;
    expect(revokePeer(db, addr)).toBe(true);
    expect(isPaired(db, addr)).toBe(false);
    expect(listPeers(db)).toHaveLength(0);
    expect(listPeers(db, { includeRevoked: true })).toHaveLength(1);
    expect(revokePeer(db, addr)).toBe(false);
  });

  it("revokePeer 支持 deviceId 维度吊销", () => {
    const { db, peer } = setup();
    const record = peer(2);
    savePeer(db, record);
    expect(revokePeer(db, record.deviceId)).toBe(true);
    expect(isPaired(db, `${record.user}@${record.device}`)).toBe(false);
  });

  it("重复 savePeer 覆盖并清除吊销标记（重新配对复活）", () => {
    const { db, peer } = setup();
    const record = peer(3);
    const addr = `${record.user}@${record.device}`;
    savePeer(db, record);
    revokePeer(db, addr);
    savePeer(db, record);
    expect(isPaired(db, addr)).toBe(true);
    expect(listPeers(db)).toHaveLength(1);
  });
});

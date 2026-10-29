import type { DatabaseSync } from "node:sqlite";
import type { PeerRecord } from "../contract/identity.js";
import { parseAddress } from "../contract/address.js";

export interface PeerRow {
  device_id: string;
  device_name: string;
  user: string;
  device: string;
  claim_name: string;
  claim_email: string;
  sign_pub_pem: string;
  enc_pub_pem: string;
  paired_at: string;
  revoked_at: string | null;
}

function toRow(record: PeerRecord): PeerRow {
  return {
    device_id: record.deviceId,
    device_name: record.deviceName,
    user: record.user,
    device: record.device,
    claim_name: record.claim.name,
    claim_email: record.claim.email,
    sign_pub_pem: record.signPubKeyPem,
    enc_pub_pem: record.encPubKeyPem,
    paired_at: record.pairedAt,
    revoked_at: record.revokedAt,
  };
}

function toRecord(row: PeerRow): PeerRecord {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    user: row.user,
    device: row.device,
    claim: { name: row.claim_name, email: row.claim_email },
    signPubKeyPem: row.sign_pub_pem,
    encPubKeyPem: row.enc_pub_pem,
    pairedAt: row.paired_at,
    revokedAt: row.revoked_at,
  };
}

/** 地址段规范化（与 server.addressSegment 一致） */
export function addressSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

export function listPeers(db: DatabaseSync, opts: { includeRevoked?: boolean } = {}): PeerRecord[] {
  const rows = (
    opts.includeRevoked
      ? db.prepare("SELECT * FROM peers ORDER BY paired_at")
      : db.prepare("SELECT * FROM peers WHERE revoked_at IS NULL ORDER BY paired_at")
  ).all() as unknown as PeerRow[];
  return rows.map(toRecord);
}

export function getPeerByDeviceId(db: DatabaseSync, deviceId: string): PeerRecord | undefined {
  const row = db
    .prepare("SELECT * FROM peers WHERE device_id = ? AND revoked_at IS NULL")
    .get(deviceId) as PeerRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function getPeerByAddress(db: DatabaseSync, addr: string): PeerRecord | undefined {
  const { user, device } = parseAddress(addr);
  const row = db
    .prepare("SELECT * FROM peers WHERE user = ? AND device = ? AND revoked_at IS NULL")
    .get(user, device) as PeerRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** 地址是否已配对（未吊销） */
export function isPaired(db: DatabaseSync, addr: string): boolean {
  return getPeerByAddress(db, addr) !== undefined;
}

/** 配对落盘（含双公钥）；重复配对覆盖并清除吊销标记 */
export function savePeer(db: DatabaseSync, record: PeerRecord): void {
  const row = toRow(record);
  db.prepare(
    `INSERT INTO peers (device_id, device_name, user, device, claim_name, claim_email,
       sign_pub_pem, enc_pub_pem, paired_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       device_name = excluded.device_name,
       user = excluded.user,
       device = excluded.device,
       claim_name = excluded.claim_name,
       claim_email = excluded.claim_email,
       sign_pub_pem = excluded.sign_pub_pem,
       enc_pub_pem = excluded.enc_pub_pem,
       paired_at = excluded.paired_at,
       revoked_at = NULL`,
  ).run(
    row.device_id,
    row.device_name,
    row.user,
    row.device,
    row.claim_name,
    row.claim_email,
    row.sign_pub_pem,
    row.enc_pub_pem,
    row.paired_at,
    row.revoked_at,
  );
}

/** 吊销（unpair）：按地址或 deviceId；返回是否命中 */
export function revokePeer(db: DatabaseSync, addrOrDeviceId: string): boolean {
  let byAddress: PeerRecord | undefined;
  try {
    byAddress = getPeerByAddress(db, addrOrDeviceId);
  } catch {
    // 非 user@device 形态：按 deviceId 处理
  }
  const target = byAddress?.deviceId ?? addrOrDeviceId;
  const result = db
    .prepare("UPDATE peers SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), target);
  return Number(result.changes) > 0;
}

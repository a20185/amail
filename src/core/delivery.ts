import type { DatabaseSync } from "node:sqlite";
import type { DeliverReq } from "../contract/api.js";
import { DeliverReqSchema } from "../contract/api.js";
import type { Receipt } from "../contract/receipt.js";
import { canonicalStringify, signCanonical } from "./crypto.js";
import {
  due as dueOutbox,
  expireDue,
  get as outboxGet,
  markAttemptWithBackoff,
  markDelivered,
} from "./outbox.js";
import { getPeerByAddress } from "./peer.js";
import { browsePeers, type PeerAdvertisement } from "../daemon/mdns.js";
import { notify as desktopNotify } from "../daemon/notify.js";
import type { DaemonCore } from "../daemon/router.js";

export interface PeerTarget {
  host: string;
  port: number;
}

export type PeerBrowse = () => Promise<PeerAdvertisement[]>;

const BROWSE_TIMEOUT_MS = 2_000;
const FETCH_TIMEOUT_MS = 5_000;

const deliveryConfig: { browse: PeerBrowse } = {
  browse: async () => browsePeers(BROWSE_TIMEOUT_MS),
};

/** 测试注入 fake mDNS（真组播路径由发布前 smoke 覆盖） */
export function configureDelivery(over: { browse?: PeerBrowse }): void {
  if (over.browse) deliveryConfig.browse = over.browse;
}

export function resetDeliveryConfig(): void {
  deliveryConfig.browse = async () => browsePeers(BROWSE_TIMEOUT_MS);
}

/** 当前生效的对端广播（含测试注入的 fake mDNS） */
export function browseNow(): Promise<PeerAdvertisement[]> {
  return deliveryConfig.browse();
}

/** mDNS 广播里解析对端地址（TXT fp 指纹 = peers 记录的 deviceId） */
export async function resolvePeerTarget(deviceId: string): Promise<PeerTarget | undefined> {
  const ads = await deliveryConfig.browse();
  for (const ad of ads) {
    if (ad.txt.fp === deviceId) {
      return { host: ad.host, port: ad.port };
    }
  }
  return undefined;
}

export function peerBaseUrl(target: PeerTarget): string {
  return `http://${target.host}:${target.port}`;
}

/** POST /v1/deliver 到对端（5s 超时）；非 2xx 抛错 */
export async function postDeliver(target: PeerTarget, req: DeliverReq): Promise<void> {
  const res = await fetch(`${peerBaseUrl(target)}/v1/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`deliver failed: ${res.status} ${JSON.stringify(detail)}`);
  }
}

/** 单次投递尝试：成功 markDelivered；失败按 P1 退避记一次失败 */
export async function attemptDelivery(
  db: DatabaseSync,
  outboxId: string,
  req: DeliverReq,
  target: PeerTarget,
): Promise<boolean> {
  try {
    await postDeliver(target, req);
    markDelivered(db, outboxId);
    return true;
  } catch (err) {
    markAttemptWithBackoff(db, outboxId, (err as Error).message);
    return false;
  }
}

/** 解析收件人地址并投递一条出箱记录（收件人须在 peers 内，含指纹校验） */
export async function deliverOutboxItem(core: DaemonCore, outboxId: string): Promise<boolean> {
  const row = outboxGet(core.db, outboxId);
  if (!row || row.state !== "queued") return false;
  const req = DeliverReqSchema.parse(JSON.parse(row.payload_json));
  const peer = getPeerByAddress(core.db, req.envelope.to);
  if (!peer) {
    markAttemptWithBackoff(core.db, outboxId, `peer not paired: ${req.envelope.to}`);
    return false;
  }
  const target = await resolvePeerTarget(peer.deviceId);
  if (!target) {
    markAttemptWithBackoff(core.db, outboxId, `peer address unresolved: ${peer.deviceId}`);
    return false;
  }
  return attemptDelivery(core.db, outboxId, req, target);
}

function safeEnvelope(payloadJson: string): { id?: string; to?: string } | undefined {
  try {
    const parsed = DeliverReqSchema.parse(JSON.parse(payloadJson));
    return { id: parsed.envelope.id, to: parsed.envelope.to };
  } catch {
    return undefined;
  }
}

async function notifySenderExpired(outboxId: string, to: string | undefined): Promise<void> {
  await desktopNotify("amail", `出箱投递超时过期（72h）：${outboxId}${to ? ` → ${to}` : ""}`);
}

/** 30s 扫描：先过期（notify 发件人 + bus），再重试全部 due */
export async function scanOutbox(core: DaemonCore, now = Date.now()): Promise<void> {
  for (const row of expireDue(core.db, now)) {
    const envelope = safeEnvelope(row.payload_json);
    core.bus.emit("outbox", {
      state: "expired",
      outboxId: row.id,
      messageId: envelope?.id,
      to: envelope?.to,
    });
    void notifySenderExpired(row.id, envelope?.to);
  }
  for (const row of dueOutbox(core.db, now)) {
    await deliverOutboxItem(core, row.id);
  }
}

/** 组装并投递回执（delivered/read）给对端；失败仅记日志，不重试风暴 */
export async function sendReceipt(
  core: DaemonCore,
  messageId: string,
  kind: Receipt["kind"],
  counterpartyAddr: string,
): Promise<boolean> {
  const peer = getPeerByAddress(core.db, counterpartyAddr);
  if (!peer) return false;
  const target = await resolvePeerTarget(peer.deviceId);
  if (!target) return false;
  const unsigned = { messageId, kind, at: new Date().toISOString() };
  const receipt: Receipt = { ...unsigned, sig: signCanonical(core.identity.signPrivPem, unsigned) };
  try {
    const res = await fetch(`${peerBaseUrl(target)}/v1/receipt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalStringify(receipt),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.error(`[amail] receipt ${kind} for ${messageId} failed:`, (err as Error).message);
    return false;
  }
}

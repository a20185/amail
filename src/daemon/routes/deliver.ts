import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Route, RouteCtx, DaemonCore, Disposer } from "../router.js";
import { sendJson } from "../router.js";
import { DeliverReqSchema, type DeliverReq } from "../../contract/api.js";
import { SealedBodySchema, type SealedBody } from "../../contract/envelope.js";
import { openBody, sha256Hex, verifyCanonical } from "../../core/crypto.js";
import { getPeerByAddress } from "../../core/peer.js";
import { saveInbound } from "../../core/store.js";
import { get as getMessage } from "../../core/store.js";
import { deliverOutboxItem, scanOutbox, sendReceipt } from "../../core/delivery.js";
import { notify as desktopNotify } from "../notify.js";

/** 仅拒未来信：createdAt > now+10min；历史信不设下限（重放由 id 去重 + 签名覆盖 id 防护） */
export const FUTURE_WINDOW_MS = 10 * 60_000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const SCAN_INTERVAL_MS = 30_000;

interface DeliverState {
  deliveredAt: string;
  idempotent?: boolean;
}



/** LAN 直投：验签 → 时间窗 → 幂等去重 → 解封 → 附件哈希+size 双校验 → 落库 → 通知 */
async function handleDeliver(ctx: RouteCtx): Promise<void> {
  const { res, db, identity, bus } = ctx;
  const parsed = DeliverReqSchema.safeParse(ctx.body ?? {});
  if (!parsed.success) {
    sendJson(res, 400, { error: "bad-request", detail: parsed.error.message });
    return;
  }
  const { envelope, parts } = parsed.data as DeliverReq;

  // 验签：设备在 peers 且未吊销
  const peer = getPeerByAddress(db, envelope.from);
  if (!peer) {
    sendJson(res, 401, { error: "not-paired", from: envelope.from });
    return;
  }
  const { sig, ...unsigned } = envelope;
  if (!verifyCanonical(peer.signPubKeyPem, unsigned, sig)) {
    sendJson(res, 401, { error: "bad-signature", id: envelope.id });
    return;
  }

  // 时间窗：仅拒未来信，历史信放行（与 72h 出箱重试兼容）
  const created = Date.parse(envelope.createdAt);
  if (Number.isNaN(created) || created > Date.now() + FUTURE_WINDOW_MS) {
    sendJson(res, 409, { error: "future-message", createdAt: envelope.createdAt });
    return;
  }

  // id 去重：同 id 幂等 200
  if (getMessage(db, envelope.id)) {
    sendJson(res, 200, { deliveredAt: new Date().toISOString(), idempotent: true });
    return;
  }

  // 载荷上限：单附件 ≤10MB、总载荷 ≤64MB（声明值预检，解密后复核实际值）
  for (const meta of envelope.attachments) {
    if (meta.size > MAX_ATTACHMENT_BYTES) {
      sendJson(res, 413, { error: "attachment-too-large", id: meta.id, size: meta.size });
      return;
    }
  }
  const declaredTotal =
    Buffer.byteLength(JSON.stringify(envelope), "utf8") +
    envelope.attachments.reduce((sum, a) => sum + a.size, 0);
  if (declaredTotal > MAX_TOTAL_BYTES) {
    sendJson(res, 413, { error: "payload-too-large", size: declaredTotal });
    return;
  }

  // 解封正文
  let sealedRaw: Buffer;
  let sealed: SealedBody;
  try {
    sealedRaw = openBody(identity.encPrivPem, envelope.seal);
    sealed = SealedBodySchema.parse(JSON.parse(sealedRaw.toString("utf8")));
  } catch {
    sendJson(res, 422, { error: "bad-seal", id: envelope.id });
    return;
  }

  // 逐 part 解密附件：sha256 与声明 size 双校验 → 落 blob（attachments/<前2位>/<hash>，去重复用）
  const opened: { body: string; handoffJson?: string; attachments: Array<{ id: string; blobPath: string }> } = {
    body: sealed.body,
    handoffJson: sealed.handoff ? JSON.stringify(sealed.handoff) : undefined,
    attachments: [],
  };
  for (const part of parts) {
    const meta = envelope.attachments.find((a) => a.id === part.id);
    if (!meta) {
      sendJson(res, 422, { error: "unknown-part", id: part.id });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = openBody(identity.encPrivPem, part.seal);
    } catch {
      sendJson(res, 422, { error: "bad-seal", id: part.id });
      return;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      sendJson(res, 413, { error: "attachment-too-large", id: part.id, size: bytes.length });
      return;
    }
    const hash = sha256Hex(bytes);
    if (hash !== meta.sha256 || bytes.length !== meta.size) {
      sendJson(res, 422, {
        error: "attachment-mismatch",
        id: part.id,
        declared: { sha256: meta.sha256, size: meta.size },
        actual: { sha256: hash, size: bytes.length },
      });
      return;
    }
    const dir = join(ctx.dirs.attachmentsDir, hash.slice(0, 2));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const blobPath = join(dir, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, bytes);
    opened.attachments.push({ id: part.id, blobPath });
  }

  saveInbound(db, envelope, opened, { sigValid: true });

  void desktopNotify("amail", `新信件：${envelope.subject}（来自 ${envelope.from}）`);
  bus.emit("new-mail", { id: envelope.id, from: envelope.from, subject: envelope.subject });

  // delivered 回执：对已配对发件人尽力回投（失败仅记日志）
  void sendReceipt(
    { db, dirs: ctx.dirs, identity, bus },
    envelope.id,
    "delivered",
    envelope.from,
  );

  sendJson(res, 200, { deliveredAt: new Date().toISOString() } satisfies DeliverState);
}

const deliverRoute: Route = {
  method: "POST",
  path: "/v1/deliver",
  lan: true,
  handler: handleDeliver,
};

export default [deliverRoute];

/**
 * 投递生命周期：挂 30s 出箱扫描（due 重试 + 72h 过期通知）、
 * bus outbox 即时直投一次（在线秒达）、bus read 回执回投。
 */
export async function init(core: DaemonCore): Promise<Disposer> {
  const timer = setInterval(() => {
    void scanOutbox(core);
  }, SCAN_INTERVAL_MS);
  timer.unref();

  const unsubscribe = core.bus.on((event) => {
    const data = event.data;
    if (
      event.type === "outbox" &&
      typeof data === "object" &&
      data !== null &&
      "outboxId" in data &&
      typeof data.outboxId === "string"
    ) {
      void deliverOutboxItem(core, data.outboxId);
      return;
    }
    if (
      event.type === "receipt" &&
      typeof data === "object" &&
      data !== null &&
      "messageId" in data &&
      typeof data.messageId === "string" &&
      "kind" in data &&
      data.kind === "read"
    ) {
      const message = getMessage(core.db, data.messageId);
      if (message && message.direction === "in") {
        void sendReceipt(core, data.messageId, "read", message.from_addr);
      }
    }
  });

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

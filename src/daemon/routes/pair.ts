import type { DatabaseSync } from "node:sqlite";
import { createPublicKey } from "node:crypto";
import { ulid } from "ulid";
import type { Route, RouteCtx } from "../router.js";
import { sendJson } from "../router.js";
import { PairOfferSchema, PairAnswerSchema, PairConfirmSigSchema, type PairOffer, type PairAnswer, type PairConfirmSig } from "../../contract/pair.js";
import type { PeerRecord } from "../../contract/identity.js";
import { rawPublicKey, sas6, signCanonical, verifyCanonical } from "../../core/crypto.js";
import { fingerprint } from "../../core/identity.js";
import { addressSegment, listPeers, revokePeer, savePeer } from "../../core/peer.js";
import { browseNow } from "../../core/delivery.js";
import { loadUserConfig, normalizeUser, userAddress } from "../server.js";

/** 会话 60s 过期（offer→answer→confirm 全程） */
export const PAIR_SESSION_TTL_MS = 60_000;

type PairStage = "offer" | "answered" | "confirmed";

interface PairSession {
  offerNonce: string;
  offer: PairOffer;
  answer: PairAnswer | null;
  /** 本端是发起方（offer 由 local-offer 创建）还是应答方（offer 经 LAN 收到） */
  local: boolean;
  /** 发起方 CLI 声明的对端地址（offer 未 answer 时用于 pending 关联，重跑不新建 offer） */
  target?: string;
  /** 对端 daemon 的已解析地址（offer/answer 时由 CLI 传入）——confirm 复用，不再依赖 mDNS */
  remoteHost?: string;
  remotePort?: number;
  confirmSigs: Map<string, PairConfirmSig>;
  peer: PeerRecord | null;
  createdAt: number;
}

/** 会话按 db 隔离：同进程双 daemon（e2e）各自独立状态机 */
const sessionsByDb = new WeakMap<DatabaseSync, Map<string, PairSession>>();

function sessions(db: DatabaseSync): Map<string, PairSession> {
  let map = sessionsByDb.get(db);
  if (!map) {
    map = new Map();
    sessionsByDb.set(db, map);
  }
  // 惰性清理过期会话
  const now = Date.now();
  for (const [nonce, session] of map) {
    if (now - session.createdAt > PAIR_SESSION_TTL_MS) map.delete(nonce);
  }
  return map;
}

function sessionOf(db: DatabaseSync, offerNonce: string): PairSession | undefined {
  return sessions(db).get(offerNonce);
}

function sasOf(session: PairSession): string | undefined {
  if (!session.answer) return undefined;
  return sas6(
    rawPublicKey(createPublicKey(session.offer.signPubKeyPem)),
    rawPublicKey(createPublicKey(session.answer.signPubKeyPem)),
  );
}

function stageOf(session: PairSession): PairStage {
  if (session.peer) return "confirmed";
  if (session.answer) return "answered";
  return "offer";
}

/** 由对端身份派生 PeerRecord（含双公钥） */
function peerRecordFrom(
  source: PairOffer | PairAnswer,
  pairedAt: string,
): PeerRecord {
  return {
    deviceId: source.deviceId,
    deviceName: source.deviceName,
    user: normalizeUser(source.claim.name),
    device: addressSegment(source.deviceName),
    claim: source.claim,
    signPubKeyPem: source.signPubKeyPem,
    encPubKeyPem: source.encPubKeyPem,
    pairedAt,
    revokedAt: null,
  };
}

/** offer/answer 自签名校验：sig 覆盖除 sig 外全部字段，deviceId = 指纹 */
function verifySelfSigned(
  source: PairOffer | PairAnswer,
): { ok: true; unsigned: Record<string, unknown> } | { ok: false; reason: string } {
  if (fingerprint(source.signPubKeyPem) !== source.deviceId) {
    return { ok: false, reason: "device-id-fingerprint-mismatch" };
  }
  const { sig, ...unsigned } = source;
  if (!verifyCanonical(source.signPubKeyPem, unsigned, sig)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, unsigned };
}

/**
 * 收到 PairConfirmSig：验签并收集；双签齐 → peers 落盘。
 * signerDeviceId = 实际提交方（本端 local-confirm = 本机；远端 confirm = 会话对端）——
 * deviceIdA/B 是会话角色而非签署方标识，不能据此选公钥。
 */
function collectConfirm(
  db: DatabaseSync,
  bus: RouteCtx["bus"],
  session: PairSession,
  confirm: PairConfirmSig,
  signerDeviceId: string,
): { status: number; body: Record<string, unknown> } {
  const answer = session.answer;
  if (!answer) return { status: 409, body: { error: "no-answer-yet" } };
  if (
    confirm.offerNonce !== session.offerNonce ||
    confirm.answerNonce !== answer.nonce ||
    confirm.deviceIdA !== session.offer.deviceId ||
    confirm.deviceIdB !== answer.deviceId
  ) {
    return { status: 400, body: { error: "confirm-mismatch" } };
  }
  const signerPub =
    signerDeviceId === session.offer.deviceId
      ? session.offer.signPubKeyPem
      : signerDeviceId === answer.deviceId
        ? answer.signPubKeyPem
        : undefined;
  if (!signerPub) {
    return { status: 400, body: { error: "not-a-session-party", deviceId: signerDeviceId } };
  }
  const { sig, ...unsigned } = confirm;
  if (!verifyCanonical(signerPub, unsigned, sig)) {
    return { status: 401, body: { error: "bad-signature", deviceId: signerDeviceId } };
  }
  if (session.confirmSigs.has(signerDeviceId)) {
    return {
      status: session.confirmSigs.size >= 2 ? 200 : 202,
      body: { stage: session.confirmSigs.size >= 2 ? "confirmed" : "answered", collected: session.confirmSigs.size },
    };
  }
  session.confirmSigs.set(signerDeviceId, confirm);
  if (session.confirmSigs.size < 2) {
    return { status: 202, body: { stage: "answered", collected: session.confirmSigs.size } };
  }
  // 双签收齐：落盘对端记录（含双公钥）
  const other = session.local
    ? peerRecordFrom(answer, new Date().toISOString())
    : peerRecordFrom(session.offer, new Date().toISOString());
  savePeer(db, other);
  session.peer = other;
  bus.emit("pairing", { stage: "confirmed", offerNonce: session.offerNonce, peer: `${other.user}@${other.device}` });
  return { status: 200, body: { stage: "confirmed", peer: `${other.user}@${other.device}` } };
}


function buildOffer(ctx: RouteCtx): PairOffer {
  const claim = loadUserConfig(ctx.dirs);
  const unsigned = {
    deviceId: ctx.identity.deviceId,
    deviceName: ctx.identity.deviceName,
    claim: { name: claim.name, email: claim.email },
    signPubKeyPem: ctx.identity.signPubPem,
    encPubKeyPem: ctx.identity.encPubPem,
    nonce: `poffer_${ulid()}`,
  };
  return { ...unsigned, sig: signCanonical(ctx.identity.signPrivPem, unsigned) };
}

function buildAnswer(ctx: RouteCtx, offerNonce: string): PairAnswer {
  const claim = loadUserConfig(ctx.dirs);
  const unsigned = {
    deviceId: ctx.identity.deviceId,
    deviceName: ctx.identity.deviceName,
    claim: { name: claim.name, email: claim.email },
    signPubKeyPem: ctx.identity.signPubPem,
    encPubKeyPem: ctx.identity.encPubPem,
    nonce: `panswer_${ulid()}`,
    offerNonce,
  };
  return { ...unsigned, sig: signCanonical(ctx.identity.signPrivPem, unsigned) };
}

function buildConfirm(ctx: RouteCtx, session: PairSession): PairConfirmSig {
  const unsigned = {
    offerNonce: session.offerNonce,
    answerNonce: session.answer!.nonce,
    deviceIdA: session.offer.deviceId,
    deviceIdB: session.answer!.deviceId,
  };
  return { ...unsigned, sig: signCanonical(ctx.identity.signPrivPem, unsigned) };
}

const routes: Route[] = [
  // ---- LAN 面：三方配对消息 ----
  {
    // 收到发起方的 offer：校验自签名 → 建会话（应答方视角）→ SSE 供 CLI 展示
    method: "POST",
    path: "/v1/pair/offer",
    lan: true,
    handler({ res, db, bus, body }) {
      const parsed = PairOfferSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "bad-request", detail: parsed.error.message });
        return;
      }
      const offer = parsed.data;
      const verified = verifySelfSigned(offer);
      if (!verified.ok) {
        sendJson(res, 401, { error: verified.reason });
        return;
      }
      const map = sessions(db);
      const existing = map.get(offer.nonce);
      if (!existing) {
        map.set(offer.nonce, {
          offerNonce: offer.nonce,
          offer,
          answer: null,
          local: false,
          confirmSigs: new Map(),
          peer: null,
          createdAt: Date.now(),
        });
      }
      bus.emit("pairing", {
        stage: "offer",
        offerNonce: offer.nonce,
        user: `${normalizeUser(offer.claim.name)}@${addressSegment(offer.deviceName)}`,
      });
      sendJson(res, 200, { offerNonce: offer.nonce });
    },
  },
  {
    // 发起方守护进程收到应答：校验 → 会话补 answer → 派生 SAS → SSE
    method: "POST",
    path: "/v1/pair/answer/:offerNonce",
    lan: true,
    handler(ctx) {
      attachAnswer(ctx, true);
    },
  },
  {
    // 应答方守护进程登记自己的 answer（同构对称）：同样派生 SAS
    method: "POST",
    path: "/v1/pair/answer",
    lan: true,
    handler(ctx) {
      attachAnswer(ctx, false);
    },
  },
  {
    // SAS 比对一致后：任一方的确认签名；双方各收齐两个 confirmSig 才落盘
    method: "POST",
    path: "/v1/pair/confirm/:offerNonce",
    lan: true,
    handler({ res, db, bus, params, body }) {
      const session = sessionOf(db, params.offerNonce!);
      if (!session) {
        sendJson(res, 404, { error: "unknown-offer", offerNonce: params.offerNonce });
        return;
      }
      const parsed = PairConfirmSigSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "bad-request", detail: parsed.error.message });
        return;
      }
      // 远端提交：签署方 = 会话对端（发起方端=应答者，应答方端=发起者）
      const counterparty = session.local ? session.answer!.deviceId : session.offer.deviceId;
      const result = collectConfirm(db, bus, session, parsed.data, counterparty);
      sendJson(res, result.status, result.body);
    },
  },

  // ---- 回环面：CLI 编排辅助 ----
  {
    // 发起：本机构造 offer 并登记会话（CLI 负责转发给对端 /v1/pair/offer）
    method: "POST",
    path: "/v1/pair/local-offer",
    lan: false,
    handler(ctx) {
      const offer = buildOffer(ctx);
      const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as { to?: unknown; host?: unknown; port?: unknown }) : undefined;
      const to = body?.to;
      sessions(ctx.db).set(offer.nonce, {
        offerNonce: offer.nonce,
        offer,
        answer: null,
        local: true,
        target: typeof to === "string" && to ? to : undefined,
        remoteHost: typeof body?.host === "string" ? body.host : undefined,
        remotePort: typeof body?.port === "number" ? body.port : undefined,
        confirmSigs: new Map(),
        peer: null,
        createdAt: Date.now(),
      });
      ctx.bus.emit("pairing", { stage: "offer", offerNonce: offer.nonce, local: true });
      sendJson(ctx.res, 200, { offer });
    },
  },
  {
    // 待推进会话列表（CLI 据此复用已显示 SAS / 等待应答的那个 nonce，不新建 offer）：
    // - local=false：远端 offer（未 answer + 已 answer 未 confirm）→ 应答方 CLI 转入应答模式
    // - local=true：本机发起的会话（含尚未 answer 的，user 取 CLI 声明的目标地址）→
    //   发起方 CLI 重跑普通 pair 时显示 SAS 或等待提示，--confirm 时复用同一会话
    method: "GET",
    path: "/v1/pair/pending",
    lan: false,
    handler({ res, db }) {
      const pending = [...sessions(db).values()]
        .filter((s) => !s.peer)
        .map((s) => {
          // 本机发起且未收到 answer 时无对端身份，只能回填 CLI 声明的目标地址
          const peer = s.local ? s.answer : s.offer;
          const user = peer
            ? `${normalizeUser(peer.claim.name)}@${addressSegment(peer.deviceName)}`
            : (s.target ?? null);
          return {
            offerNonce: s.offerNonce,
            user,
            deviceId: peer?.deviceId ?? null,
            local: s.local,
            stage: stageOf(s),
            remoteHost: s.remoteHost ?? null,
            remotePort: s.remotePort ?? null,
          };
        })
        .filter((item) => item.user !== null);
      sendJson(res, 200, pending);
    },
  },
  {
    // 应答：本机构造 answer、登记会话并派生 SAS（CLI 转发 answer 给发起方）
    method: "POST",
    path: "/v1/pair/local-answer/:offerNonce",
    lan: false,
    handler(ctx) {
      const session = sessionOf(ctx.db, ctx.params.offerNonce!);
      if (!session || session.local) {
        sendJson(ctx.res, 404, { error: "unknown-offer", offerNonce: ctx.params.offerNonce });
        return;
      }
      const ab = ctx.body && typeof ctx.body === "object" ? (ctx.body as { host?: unknown; port?: unknown }) : undefined;
      if (typeof ab?.host === "string" && typeof ab?.port === "number") {
        session.remoteHost = ab.host;
        session.remotePort = ab.port;
      }
      if (session.answer) {
        sendJson(ctx.res, 200, { answer: session.answer, sas: sasOf(session) });
        return;
      }
      const answer = buildAnswer(ctx, session.offerNonce);
      const verified = verifySelfSigned(answer);
      if (!verified.ok) {
        sendJson(ctx.res, 500, { error: verified.reason });
        return;
      }
      session.answer = answer;
      const sas = sasOf(session)!;
      ctx.bus.emit("pairing", { stage: "answered", offerNonce: session.offerNonce, sas });
      sendJson(ctx.res, 200, { answer, sas });
    },
  },
  {
    // 确认：本机构造确认签名，提交本端会话并返回签名（CLI 转发给对端）
    method: "POST",
    path: "/v1/pair/local-confirm/:offerNonce",
    lan: false,
    handler(ctx) {
      const session = sessionOf(ctx.db, ctx.params.offerNonce!);
      if (!session) {
        sendJson(ctx.res, 404, { error: "unknown-offer", offerNonce: ctx.params.offerNonce });
        return;
      }
      if (!session.answer) {
        sendJson(ctx.res, 409, { error: "no-answer-yet" });
        return;
      }
      const confirm = buildConfirm(ctx, session);
      // 本端提交：签署方 = 本机
      const result = collectConfirm(ctx.db, ctx.bus, session, confirm, ctx.identity.deviceId);
      sendJson(ctx.res, result.status, { ...result.body, confirm });
    },
  },
  {
    // 会话状态（CLI 轮询 SAS / 完成态）
    method: "GET",
    path: "/v1/pair/status/:offerNonce",
    lan: false,
    handler({ res, db, params }) {
      const session = sessionOf(db, params.offerNonce!);
      if (!session) {
        sendJson(res, 404, { error: "unknown-offer", offerNonce: params.offerNonce });
        return;
      }
      sendJson(res, 200, {
        stage: stageOf(session),
        sas: sasOf(session) ?? null,
        peer: session.peer ? `${session.peer.user}@${session.peer.device}` : null,
      });
    },
  },

  // ---- 回环面：peers 管理 ----
  {
    method: "GET",
    path: "/v1/peers",
    lan: false,
    handler({ res, db }) {
      sendJson(res, 200, listPeers(db));
    },
  },
  {
    // mDNS 扫描可配对设备（测试经 configureDelivery 注入 fake）
    method: "GET",
    path: "/v1/peers/scan",
    lan: false,
    async handler({ res, dirs, identity }) {
      const ads = await browseNow();
      const self = userAddress(dirs, identity);
      sendJson(
        res,
        200,
        ads.map((ad) => ({
          name: ad.name,
          host: ad.host,
          port: ad.port,
          fp: ad.txt.fp ?? "",
          user: ad.txt.user ?? "",
        })).filter((ad) => ad.user !== self),
      );
    },
  },
  {
    method: "POST",
    path: "/v1/peers/revoke",
    lan: false,
    handler({ res, db, body }) {
      const addr = body && typeof body === "object" && "addr" in body ? body.addr : undefined;
      if (typeof addr !== "string" || !addr) {
        sendJson(res, 400, { error: "addr-required" });
        return;
      }
      sendJson(res, 200, { revoked: revokePeer(db, addr), addr });
    },
  },
];

function attachAnswer(ctx: RouteCtx, requireLocal: boolean): void {
  const parsed = PairAnswerSchema.safeParse(ctx.body ?? {});
  if (!parsed.success) {
    sendJson(ctx.res, 400, { error: "bad-request", detail: parsed.error.message });
    return;
  }
  const answer = parsed.data;
  const nonce = requireLocal ? ctx.params.offerNonce : answer.offerNonce;
  if (answer.offerNonce !== nonce) {
    sendJson(ctx.res, 400, { error: "offer-nonce-mismatch" });
    return;
  }
  const session = sessionOf(ctx.db, nonce!);
  if (!session || (requireLocal && !session.local) || (!requireLocal && session.local)) {
    sendJson(ctx.res, 404, { error: "unknown-offer", offerNonce: nonce });
    return;
  }
  const verified = verifySelfSigned(answer);
  if (!verified.ok) {
    sendJson(ctx.res, 401, { error: verified.reason });
    return;
  }
  if (!session.answer) {
    if (answer.deviceId === session.offer.deviceId) {
      sendJson(ctx.res, 409, { error: "self-pairing" });
      return;
    }
    session.answer = answer;
  }
  const sas = sasOf(session)!;
  ctx.bus.emit("pairing", { stage: "answered", offerNonce: session.offerNonce, sas });
  sendJson(ctx.res, 200, { sas });
}

export default routes;

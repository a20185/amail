import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ulid } from "ulid";
import { SendMessageReqSchema } from "../../contract/api.js";
import { canonicalJson } from "../../contract/envelope.js";
import { parseAddress } from "../../contract/address.js";
import type { Envelope, SealedBody } from "../../contract/envelope.js";
import { canonicalStringify, sealBody, sha256Hex, signCanonical } from "../../core/crypto.js";
import { loadUserConfig, userAddress } from "../server.js";
import { saveOutbound } from "../../core/store.js";
import { sendJson, type Route } from "../router.js";

interface PeerRow {
  enc_pub_pem: string;
}

/** 回环面本地发信：密封 + 签名 + 出箱原子落库（不联网） */
const route: Route = {
  method: "POST",
  path: "/v1/send",
  lan: false,
  async handler({ res, db, dirs, identity, bus, body }) {
    const parsed = SendMessageReqSchema.parse(body ?? {});

    // 未配对 → 409，明确拒绝并提示先 amail pair（不产生草稿死状态）
    const { user, device } = parseAddress(parsed.to);
    const peer = db
      .prepare(
        "SELECT enc_pub_pem FROM peers WHERE user = ? AND device = ? AND revoked_at IS NULL",
      )
      .get(user, device) as PeerRow | undefined;
    if (!peer) {
      sendJson(res, 409, { error: "not-paired", hint: "run `amail pair` before sending" });
      return;
    }

    // 密封前提取本机明文副本
    const localCopy = {
      body: parsed.body,
      handoffJson: parsed.handoff ? canonicalStringify(parsed.handoff) : undefined,
    };

    // 附件：refs 读文件 → 元数据 + 逐个密封的 parts
    const attachments: Envelope["attachments"] = [];
    const parts: { id: string; seal: Envelope["seal"] }[] = [];
    for (const ref of parsed.refs) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(ref);
      } catch (err) {
        sendJson(res, 400, { error: "unreadable-ref", ref, detail: (err as Error).message });
        return;
      }
      const id = `att_${ulid()}`;
      attachments.push({ id, name: basename(ref), sha256: sha256Hex(bytes), size: bytes.length });
      parts.push({ id, seal: sealBody(peer.enc_pub_pem, bytes) });
    }

    const sealed: SealedBody = {
      body: parsed.body,
      handoff: parsed.handoff,
      attachmentIds: attachments.map((a) => a.id),
    };

    const inReplyTo = parsed.inReplyTo ?? null;
    const references = inReplyTo
      ? [inReplyTo, ...parsed.refs.filter((r) => r !== inReplyTo)]
      : parsed.refs;

    const claim = loadUserConfig(dirs);
    const unsigned = {
      v: 1 as const,
      id: `msg_${ulid()}`,
      from: userAddress(dirs, identity),
      to: parsed.to,
      subject: parsed.subject,
      inReplyTo,
      references,
      createdAt: new Date().toISOString(),
      claim: { name: claim.name, email: claim.email },
      seal: sealBody(peer.enc_pub_pem, Buffer.from(canonicalJson(sealed), "utf8")),
      attachments,
    };
    const envelope: Envelope = { ...unsigned, sig: signCanonical(identity.signPrivPem, unsigned) };

    const deliverReq = { envelope, parts };
    const { messageId, outboxId } = saveOutbound(db, deliverReq, localCopy);
    bus.emit("outbox", { messageId, outboxId, to: parsed.to });
    sendJson(res, 200, { messageId });
  },
};

export default [route];

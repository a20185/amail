import type { Route } from "../router.js";
import { sendJson } from "../router.js";
import { ReceiptSchema } from "../../contract/receipt.js";
import { verifyCanonical } from "../../core/crypto.js";
import { getPeerByAddress } from "../../core/peer.js";
import { get as getMessage, recordReceipt } from "../../core/store.js";

/** LAN 回执：验签（对端 = 该信件的收/发对端）→ receipts 落库（幂等）+ bus */
const receiptRoute: Route = {
  method: "POST",
  path: "/v1/receipt",
  lan: true,
  handler({ res, db, bus, body }) {
    const parsed = ReceiptSchema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "bad-request", detail: parsed.error.message });
      return;
    }
    const receipt = parsed.data;

    const message = getMessage(db, receipt.messageId);
    if (!message) {
      sendJson(res, 404, { error: "unknown-message", messageId: receipt.messageId });
      return;
    }

    // 对端地址：来信的回执来自发件人；去信的回执来自收件人
    const counterparty = message.direction === "in" ? message.from_addr : message.to_addr;
    const peer = getPeerByAddress(db, counterparty);
    if (!peer) {
      sendJson(res, 401, { error: "not-paired", from: counterparty });
      return;
    }

    const { sig, ...unsigned } = receipt;
    if (!verifyCanonical(peer.signPubKeyPem, unsigned, sig)) {
      sendJson(res, 401, { error: "bad-signature", messageId: receipt.messageId });
      return;
    }

    recordReceipt(db, receipt.messageId, receipt.kind);
    bus.emit("receipt", { messageId: receipt.messageId, kind: receipt.kind, remote: true });
    sendJson(res, 200, { ok: true });
  },
};

export default [receiptRoute];

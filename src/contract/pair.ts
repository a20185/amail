import { z } from "zod";
import { DEVICE_ID, UserClaimSchema } from "./identity.js";

const PEM = /^-----BEGIN PUBLIC KEY-----[\s\S]*-----END PUBLIC KEY-----\s*$/;
const Nonce = z.string().min(1);
const Sig = z.string().min(1);

/** 配对发起方：sig 覆盖自身全部字段（含 nonce，不含 sig） */
export const PairOfferSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  deviceName: z.string().min(1),
  claim: UserClaimSchema,
  signPubKeyPem: z.string().regex(PEM),
  encPubKeyPem: z.string().regex(PEM),
  nonce: Nonce,
  sig: Sig,
});
export type PairOffer = z.infer<typeof PairOfferSchema>;

/** 配对应答方：同构 + offerNonce；sig 同样不含 sig 自身 */
export const PairAnswerSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  deviceName: z.string().min(1),
  claim: UserClaimSchema,
  signPubKeyPem: z.string().regex(PEM),
  encPubKeyPem: z.string().regex(PEM),
  nonce: Nonce,
  offerNonce: Nonce,
  sig: Sig,
});
export type PairAnswer = z.infer<typeof PairAnswerSchema>;

/** SAS 比对通过后的确认签名：签署方对 (offerNonce‖answerNonce‖deviceIdA‖deviceIdB) 的签名 */
export const PairConfirmSigSchema = z.object({
  offerNonce: Nonce,
  answerNonce: Nonce,
  deviceIdA: z.string().regex(DEVICE_ID),
  deviceIdB: z.string().regex(DEVICE_ID),
  sig: Sig,
});
export type PairConfirmSig = z.infer<typeof PairConfirmSigSchema>;

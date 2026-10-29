import { z } from "zod";

export const DEVICE_ID = /^[0-9a-f]{16}$/;
const PEM = /^-----BEGIN PUBLIC KEY-----[\s\S]*-----END PUBLIC KEY-----\s*$/;

export const UserClaimSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});
export type UserClaim = z.infer<typeof UserClaimSchema>;

/** 本机设备身份：签名/加密两把公钥独立，不可混用 */
export const DeviceIdentitySchema = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  deviceName: z.string().min(1),
  claim: UserClaimSchema,
  signPubKeyPem: z.string().regex(PEM),
  encPubKeyPem: z.string().regex(PEM),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

/** 已配对对端记录 */
export const PeerRecordSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  deviceName: z.string().min(1),
  user: z.string().min(1),
  device: z.string().min(1),
  claim: UserClaimSchema,
  signPubKeyPem: z.string().regex(PEM),
  encPubKeyPem: z.string().regex(PEM),
  pairedAt: z.string().datetime(),
  revokedAt: z.union([z.null(), z.string().datetime()]),
});
export type PeerRecord = z.infer<typeof PeerRecordSchema>;

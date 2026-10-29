import { z } from "zod";
import { AddressSchema } from "./address.js";
import { EnvelopeSchema, HandoffSchema, SealSchema } from "./envelope.js";
import { DEVICE_ID } from "./identity.js";

export const AliveInfoSchema = z.object({
  user: AddressSchema,
  deviceName: z.string().min(1),
  fingerprint: z.string().regex(DEVICE_ID),
  version: z.string(),
  pairedCount: z.number().int().nonnegative(),
});
export type AliveInfo = z.infer<typeof AliveInfoSchema>;

export const InboxQuerySchema = z.object({
  project: z.string().optional(),
  unread: z.boolean().optional(),
  all: z.boolean().optional(),
});
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const SendMessageReqSchema = z.object({
  to: AddressSchema,
  subject: z.string().min(1),
  body: z.string().max(4000),
  inReplyTo: z.string().optional(),
  refs: z.array(z.string()),
  handoff: HandoffSchema.optional(),

});
export type SendMessageReq = z.infer<typeof SendMessageReqSchema>;

export const DeliverReqSchema = z.object({
  envelope: EnvelopeSchema,
  parts: z.array(z.object({ id: z.string().regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/), seal: SealSchema })),
});
export type DeliverReq = z.infer<typeof DeliverReqSchema>;

export const DeliverResSchema = z.object({
  deliveredAt: z.string().datetime(),
});
export type DeliverRes = z.infer<typeof DeliverResSchema>;

export const WorkspaceSyncQuerySchema = z.object({
  since: z.number().int().nonnegative(),
});
export type WorkspaceSyncQuery = z.infer<typeof WorkspaceSyncQuerySchema>;

/** 适配器产出的原始镜像事件（无序号） */
export const RawMirrorEventSchema = z.object({
  t: z.string().datetime(),
  sessionId: z.string().min(1),
  role: z.string().optional(),
  text: z.string().optional(),
  path: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});
export type RawMirrorEvent = z.infer<typeof RawMirrorEventSchema>;

/** 房主分配的工作区级统一单调递增序号（跨会话共享） */
export const MirrorEventSchema = RawMirrorEventSchema.extend({
  n: z.number().int().nonnegative(),
});
export type MirrorEvent = z.infer<typeof MirrorEventSchema>;

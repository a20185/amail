import { z } from "zod";
import { AddressSchema } from "./address.js";
import { AttachmentMetaSchema } from "./attachment.js";
import { UserClaimSchema } from "./identity.js";
import type { ZodTypeAny } from "zod";

export const HandoffSchema = z.object({
  progress: z.string().max(2000),
  description: z.string().max(4000),
  questions: z.array(z.string()).min(1).max(10),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/** 解封后的密封体：正文 + 可选 handoff + 附件 id 清单 */
export const SealedBodySchema = z.object({
  body: z.string(),
  handoff: HandoffSchema.optional(),
  attachmentIds: z.array(z.string()),
});
export type SealedBody = z.infer<typeof SealedBodySchema>;

export const SealSchema = z.object({
  alg: z.literal("x25519-aes256gcm"),
  epk: z.string(),
  iv: z.string(),
  body: z.string(),
});
export type Seal = z.infer<typeof SealSchema>;

export const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/),
    from: AddressSchema,
    to: AddressSchema,
    subject: z.string().min(1),
    inReplyTo: z.union([z.null(), z.string()]),
    references: z.array(z.string()),
    createdAt: z.string().datetime(),
    claim: UserClaimSchema,
    seal: SealSchema,
    attachments: z.array(AttachmentMetaSchema),
    sig: z.string(),
  })
  .superRefine((env, ctx) => {
    if (env.inReplyTo !== null && !env.references.includes(env.inReplyTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["references"],
        message: "references must contain inReplyTo when set",
      });
    }
  });
export type Envelope = z.infer<typeof EnvelopeSchema>;

function orderKeys(value: unknown, schema?: ZodTypeAny): unknown {
  if (
    schema instanceof z.ZodObject &&
    value !== null &&
    typeof value === "object"
  ) {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const shape = schema.shape as Record<string, ZodTypeAny>;
    for (const key of Object.keys(shape)) {
      if (key in input) out[key] = orderKeys(input[key], shape[key]);
    }
    for (const key of Object.keys(input)) {
      if (!(key in shape)) out[key] = input[key];
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => orderKeys(v, arrayItemSchema(schema)));
  return value;
}

function arrayItemSchema(schema?: ZodTypeAny): ZodTypeAny | undefined {
  const def = schema?._def as { type?: ZodTypeAny } | undefined;
  return def?.type;
}

/** 规范 JSON：键序 = zod 声明序（传 schema 时），无空白 */
export function canonicalJson(value: unknown, schema?: ZodTypeAny): string {
  return JSON.stringify(orderKeys(value, schema));
}

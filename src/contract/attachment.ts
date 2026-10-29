import { z } from "zod";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 信封内附件元数据：{id,name,sha256,size} */
export const AttachmentMetaSchema = z.object({
  id: z.string().regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/),
  name: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
  size: z.number().int().nonnegative(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** 工作区 artifact 注册元数据 */
export const ArtifactMetaSchema = z.object({
  artifactId: z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  note: z.string().optional(),
  tags: z.array(z.string()),
  sha256: z.string().regex(SHA256_HEX),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

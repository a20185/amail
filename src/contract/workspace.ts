import { z } from "zod";
import { AddressSchema } from "./address.js";
import { ArtifactMetaSchema } from "./attachment.js";

const EventId = z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);

export const ActionPayloadSchema = z.object({
  who: AddressSchema,
  content: z.string().min(1).max(1000),
  note: z.string().optional(),
  cc: z.array(AddressSchema),
});
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export const TodoPayloadSchema = z.object({
  id: z.string().regex(/^td_[0-9A-HJKMNP-TV-Z]{26}$/),
  title: z.string().min(1),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  dueRange: z.object({ from: z.string(), to: z.string() }).optional(),
  status: z.enum(["todo", "doing", "done", "dropped"]),
});
export type TodoPayload = z.infer<typeof TodoPayloadSchema>;

export const MembershipPayloadSchema = z.object({
  op: z.enum(["add", "remove"]),
  member: AddressSchema,
});
export type MembershipPayload = z.infer<typeof MembershipPayloadSchema>;

export const SessionAttachPayloadSchema = z.object({
  sessionId: z.string().min(1),
  cli: z.enum(["claude-code", "pi", "opencode"]),
  cwd: z.string().min(1),
  title: z.string().optional(),
});
export type SessionAttachPayload = z.infer<typeof SessionAttachPayloadSchema>;

/** attachEventId = 被摘挂载的来源 attach 事件 eventId（防在途旧 detach 摘新挂载） */
export const SessionDetachPayloadSchema = z.object({
  sessionId: z.string().min(1),
  attachEventId: EventId,
});
export type SessionDetachPayload = z.infer<typeof SessionDetachPayloadSchema>;

const EventCommon = {
  seq: z.number().int().nonnegative(),
  eventId: EventId,
  actor: AddressSchema,
  at: z.string().datetime(),
  sig: z.string(),
};

export const WorkspaceEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...EventCommon, kind: z.literal("action"), payload: ActionPayloadSchema }),
  z.object({ ...EventCommon, kind: z.literal("todo"), payload: TodoPayloadSchema }),
  z.object({ ...EventCommon, kind: z.literal("artifact"), payload: ArtifactMetaSchema }),
  z.object({ ...EventCommon, kind: z.literal("membership"), payload: MembershipPayloadSchema }),
  z.object({ ...EventCommon, kind: z.literal("session.attach"), payload: SessionAttachPayloadSchema }),
  z.object({ ...EventCommon, kind: z.literal("session.detach"), payload: SessionDetachPayloadSchema }),
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

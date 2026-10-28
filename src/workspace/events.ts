import { z } from "zod";
import { ulid } from "ulid";
import { AddressSchema } from "../contract/address.js";
import { ArtifactMetaSchema, type ArtifactMeta } from "../contract/attachment.js";
import { canonicalStringify, signCanonical, verifyCanonical } from "../core/crypto.js";
import type {
  ActionPayload,
  MembershipPayload,
  SessionAttachPayload,
  SessionDetachPayload,
  TodoPayload,
  WorkspaceEvent,
} from "../contract/workspace.js";
import {
  ActionPayloadSchema,
  MembershipPayloadSchema,
  SessionAttachPayloadSchema,
  SessionDetachPayloadSchema,
  TodoPayloadSchema,
  WorkspaceEventSchema,
} from "../contract/workspace.js";

/** 事件 id：evt_ + ULID */
export function newEventId(): string {
  return `evt_${ulid()}`;
}

/** todo id：td_ + ULID */
export function newTodoId(): string {
  return `td_${ulid()}`;
}

const EventIdSchema = z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);

/** 提交形事件：无 seq（seq 由房主分配），sig 覆盖 {eventId,actor,kind,payload,at} */
const SubmitCommon = {
  eventId: EventIdSchema,
  actor: AddressSchema,
  at: z.string().datetime(),
  sig: z.string(),
};

export const SubmitEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...SubmitCommon, kind: z.literal("action"), payload: ActionPayloadSchema }),
  z.object({ ...SubmitCommon, kind: z.literal("todo"), payload: TodoPayloadSchema }),
  z.object({ ...SubmitCommon, kind: z.literal("artifact"), payload: ArtifactMetaSchema }),
  z.object({ ...SubmitCommon, kind: z.literal("membership"), payload: MembershipPayloadSchema }),
  z.object({ ...SubmitCommon, kind: z.literal("session.attach"), payload: SessionAttachPayloadSchema }),
  z.object({ ...SubmitCommon, kind: z.literal("session.detach"), payload: SessionDetachPayloadSchema }),
]);
export type SubmitEvent = z.infer<typeof SubmitEventSchema>;


export interface SigningBase {
  eventId: string;
  actor: string;
  kind: string;
  payload: unknown;
  at: string;
}

/** 提取签名载荷 */
export function eventSigningPayload(event: SubmitEvent | WorkspaceEvent | SigningBase): SigningBase {
  return {
    eventId: event.eventId,
    actor: event.actor,
    kind: event.kind,
    payload: event.payload,
    at: event.at,
  };
}

export interface EventByKind {
  action: ActionPayload;
  todo: TodoPayload;
  artifact: ArtifactMeta;
  membership: MembershipPayload;
  "session.attach": SessionAttachPayload;
  "session.detach": SessionDetachPayload;
}

/** 本地构造并签名一条提交形事件 */
export function makeEvent<K extends keyof EventByKind & SubmitEvent["kind"]>(
  privPem: string,
  actor: string,
  kind: K,
  payload: EventByKind[K],
  at: string = new Date().toISOString(),
): SubmitEvent {
  const eventId = newEventId();
  const base = { eventId, actor, kind, payload, at };
  const sig = signCanonical(privPem, base);
  return { ...base, sig } as SubmitEvent;
}

/** 验证提交形事件签名（sig 覆盖五段，不含 seq） */
export function verifyEventSig(pubPem: string, event: SubmitEvent | WorkspaceEvent): boolean {
  try {
    return verifyCanonical(pubPem, eventSigningPayload(event), event.sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 投影折叠
// ---------------------------------------------------------------------------

export interface ActionRecord {
  seq: number;
  eventId: string;
  actor: string;
  at: string;
  payload: ActionPayload;
}

export interface TodoRecord {
  id: string;
  title: string;
  priority: number;
  dueRange?: { from: string; to: string };
  status: "todo" | "doing" | "done" | "dropped";
  seq: number;
  eventId: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  seq: number;
  eventId: string;
  payload: ArtifactMeta;
}

/** attached[] 挂载项：attachEventId = 来源 attach 事件的 eventId（detach 匹配用） */
export interface AttachedEntry {
  sessionId: string;
  attachEventId: string;
  actor: string;
  at: string;
  cli: SessionAttachPayload["cli"];
  cwd: string;
  title?: string;
}

export interface WorkspaceState {
  actions: ActionRecord[];
  todos: TodoRecord[];
  artifacts: ArtifactRecord[];
  members: string[];
  attached: AttachedEntry[];
}

export function emptyState(): WorkspaceState {
  return { actions: [], todos: [], artifacts: [], members: [], attached: [] };
}

/**
 * 纯函数折叠：applyEvent(state, event) → state（原地更新并返回）。
 * - todo 按 id upsert 状态机；action 追加；membership 增删；artifact 按 artifactId upsert
 * - session.attach 按 eventId upsert attached[]（同 sessionId 新挂载取代旧挂载，携带新 attachEventId）
 * - session.detach 仅当 attached[] 中该 sessionId 的挂载 attachEventId 匹配时摘除；
 *   不匹配（已被新挂载取代）→ 投影 no-op，事件仅作审计记录
 */
export function applyEvent(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.kind) {
    case "action":
      state.actions.push({
        seq: event.seq,
        eventId: event.eventId,
        actor: event.actor,
        at: event.at,
        payload: event.payload,
      });
      break;
    case "todo": {
      const p = event.payload;
      const existing = state.todos.find((t) => t.id === p.id);
      if (existing) {
        existing.title = p.title;
        existing.priority = p.priority;
        existing.dueRange = p.dueRange;
        existing.status = p.status;
        existing.seq = event.seq;
        existing.eventId = event.eventId;
        existing.updatedAt = event.at;
      } else {
        state.todos.push({
          id: p.id,
          title: p.title,
          priority: p.priority,
          dueRange: p.dueRange,
          status: p.status,
          seq: event.seq,
          eventId: event.eventId,
          updatedAt: event.at,
        });
      }
      break;
    }
    case "artifact": {
      const existing = state.artifacts.find((a) => a.payload.artifactId === event.payload.artifactId);
      if (existing) {
        existing.payload = event.payload;
        existing.seq = event.seq;
        existing.eventId = event.eventId;
      } else {
        state.artifacts.push({ seq: event.seq, eventId: event.eventId, payload: event.payload });
      }
      break;
    }
    case "membership": {
      if (event.payload.op === "add") {
        if (!state.members.includes(event.payload.member)) state.members.push(event.payload.member);
      } else {
        state.members = state.members.filter((m) => m !== event.payload.member);
      }
      break;
    }
    case "session.attach": {
      const p = event.payload;
      const existing = state.attached.find((a) => a.sessionId === p.sessionId);
      if (existing) {
        existing.attachEventId = event.eventId;
        existing.actor = event.actor;
        existing.at = event.at;
        existing.cli = p.cli;
        existing.cwd = p.cwd;
        existing.title = p.title;
      } else {
        state.attached.push({
          sessionId: p.sessionId,
          attachEventId: event.eventId,
          actor: event.actor,
          at: event.at,
          cli: p.cli,
          cwd: p.cwd,
          title: p.title,
        });
      }
      break;
    }
    case "session.detach": {
      const p = event.payload;
      const current = state.attached.find((a) => a.sessionId === p.sessionId);
      if (current && current.attachEventId === p.attachEventId) {
        state.attached = state.attached.filter((a) => a.sessionId !== p.sessionId);
      }
      // attachEventId 不匹配（已被新挂载取代）→ no-op，事件仅作审计记录
      break;
    }
  }
  return state;
}

/** 折叠事件序列（须按 seq 升序） */
export function foldEvents(events: WorkspaceEvent[], init: WorkspaceState = emptyState()): WorkspaceState {
  for (const event of events) applyEvent(init, event);
  return init;
}

/** 解析 workspace_events.event_json 行 */
export function parseEventJson(json: string): WorkspaceEvent {
  const parsed = WorkspaceEventSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`corrupt workspace event: ${parsed.error.message}`);
  return parsed.data;
}

/** 事件序列化（存库形态） */
export function serializeEvent(event: WorkspaceEvent): string {
  return canonicalStringify(event);
}

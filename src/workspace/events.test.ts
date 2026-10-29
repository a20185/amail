import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { WorkspaceEventSchema, type WorkspaceEvent } from "../contract/workspace.js";
import {
  applyEvent,
  emptyState,
  eventSigningPayload,
  foldEvents,
  makeEvent,
  verifyEventSig,
  type SubmitEvent,
} from "./events.js";
import { canonicalStringify, signCanonical } from "../core/crypto.js";

function keypair(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function seqEvent(seq: number, event: SubmitEvent): WorkspaceEvent {
  return WorkspaceEventSchema.parse({ ...event, seq });
}
describe("events: applyEvent 折叠", () => {
  const host = keypair();
  const actor = "alice@laptop";

  it("action 追加、todo 按 id upsert、membership 增删", () => {
    const state = emptyState();
    applyEvent(state, seqEvent(1, makeEvent(host.priv, actor, "membership", { op: "add", member: actor })));
    applyEvent(state, seqEvent(2, makeEvent(host.priv, actor, "action", { who: actor, content: "did it", cc: [] })));
    const todoId = "td_01HGV2KP5Z4W7R8X9Y0ZABCDEF";
    applyEvent(
      state,
      seqEvent(3, makeEvent(host.priv, actor, "todo", { id: todoId, title: "t1", priority: 2, status: "todo" })),
    );
    applyEvent(
      state,
      seqEvent(4, makeEvent(host.priv, actor, "todo", { id: todoId, title: "t1", priority: 1, status: "doing" })),
    );

    expect(state.members).toEqual([actor]);
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]!.seq).toBe(2);
    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]!.status).toBe("doing");
    expect(state.todos[0]!.priority).toBe(1);

    applyEvent(state, seqEvent(5, makeEvent(host.priv, actor, "membership", { op: "remove", member: actor })));
    expect(state.members).toEqual([]);
  });

  it("artifact 按 artifactId upsert", () => {
    const state = emptyState();
    const art = { artifactId: "art_01HGV2KP5Z4W7R8X9Y0ZABCDEF", name: "a.bin", mime: "application/octet-stream", size: 3, tags: ["x"], sha256: "a".repeat(64) };
    applyEvent(state, seqEvent(1, makeEvent(host.priv, actor, "artifact", art)));
    applyEvent(state, seqEvent(2, makeEvent(host.priv, actor, "artifact", { ...art, name: "renamed" })));
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]!.payload.name).toBe("renamed");
  });

  it("session.attach 按 eventId upsert；detach 仅在 attachEventId 匹配时摘除", () => {
    const state = emptyState();
    const att1 = seqEvent(1, makeEvent(host.priv, actor, "session.attach", { sessionId: "s1", cli: "claude-code", cwd: "/tmp" }));
    applyEvent(state, att1);
    expect(state.attached).toHaveLength(1);
    expect(state.attached[0]!.attachEventId).toBe(att1.eventId);

    // 旧 detach（不匹配）→ no-op，事件仅作审计
    const stale = makeEvent(host.priv, actor, "session.detach", { sessionId: "s1", attachEventId: "we_01HGV2KP5Z4W7R8X9Y0ZABCXYZ" });
    applyEvent(state, seqEvent(2, stale));
    expect(state.attached).toHaveLength(1);

    // 新挂载取代旧挂载
    const att2 = seqEvent(3, makeEvent(host.priv, actor, "session.attach", { sessionId: "s1", cli: "pi", cwd: "/x" }));
    applyEvent(state, att2);
    expect(state.attached).toHaveLength(1);
    expect(state.attached[0]!.attachEventId).toBe(att2.eventId);

    // 携带旧 attachEventId 的迟到 detach → no-op
    applyEvent(state, seqEvent(4, makeEvent(host.priv, actor, "session.detach", { sessionId: "s1", attachEventId: att1.eventId })));
    expect(state.attached).toHaveLength(1);

    // 匹配新 attachEventId 的 detach → 摘除
    applyEvent(state, seqEvent(5, makeEvent(host.priv, actor, "session.detach", { sessionId: "s1", attachEventId: att2.eventId })));
    expect(state.attached).toHaveLength(0);
  });
});

describe("events: 签名", () => {
  it("生成的事件 id 前缀 we_（与契约一致）", () => {
    expect(makeEvent(keypair().priv, "alice@laptop", "action", { who: "a@b", content: "x", cc: [] }).eventId).toMatch(
      /^we_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
  });

  it("sig 覆盖五段（不含 seq），seq 不参与验签", () => {
    const host = keypair();
    const other = keypair();
    const event = makeEvent(host.priv, "alice@laptop", "action", { who: "alice@laptop", content: "hi", cc: [] });
    expect(verifyEventSig(host.pub, event)).toBe(true);
    expect(verifyEventSig(other.pub, event)).toBe(false);
    // 篡改 payload 后失效
    const tampered = { ...event, payload: { ...event.payload, content: "evil" } } as typeof event;
    expect(verifyEventSig(host.pub, tampered)).toBe(false);
    // 同一签名对任意 seq 的完整事件仍有效（seq 由房主分配）
    const withSeq = { ...event, seq: 42 } as WorkspaceEvent;
    expect(verifyEventSig(host.pub, withSeq)).toBe(true);
  });

  it("eventSigningPayload 排除 seq 与 sig，payload 键序归一为契约声明序", () => {
    const host = keypair();
    const event = makeEvent(host.priv, "alice@laptop", "membership", { op: "add", member: "bob@pc" });
    const payload = eventSigningPayload(event);
    expect(payload).toEqual({
      eventId: event.eventId,
      actor: event.actor,
      kind: "membership",
      payload: event.payload,
      at: event.at,
    });
    // 手工重签一致
    expect(signCanonical(host.priv, payload)).toBe(event.sig);

    // 乱序构造的 artifact payload → 声明序（契约序）归一后建签并验过
    const scrambled = {
      sha256: "a".repeat(64),
      tags: ["t"],
      size: 3,
      mime: "text/plain",
      name: "n",
      artifactId: "art_01HGV2KP5Z4W7R8X9Y0ZABCDEF",
    };
    const artifact = makeEvent(host.priv, "alice@laptop", "artifact", scrambled);
    expect(Object.keys(artifact.payload)).toEqual(["artifactId", "name", "mime", "size", "tags", "sha256"]);
    expect(verifyEventSig(host.pub, artifact)).toBe(true);
    // 验签侧同样按声明序归一：字典序重排的载荷副本仍属同一事件
    const shuffled = {
      ...artifact,
      payload: { sha256: scrambled.sha256, tags: ["t"], size: 3, mime: "text/plain", name: "n", artifactId: scrambled.artifactId },
    } as typeof artifact;
    expect(verifyEventSig(host.pub, shuffled)).toBe(true);
  });
});

describe("events: foldEvents", () => {
  it("按序折叠等价于逐条 applyEvent", () => {
    const host = keypair();
    const actor = "alice@laptop";
    const events = [
      seqEvent(1, makeEvent(host.priv, actor, "membership", { op: "add", member: actor })),
      seqEvent(2, makeEvent(host.priv, actor, "action", { who: actor, content: "x", cc: [] })),
    ];
    const folded = foldEvents(events);
    expect(folded.members).toEqual([actor]);
    expect(folded.actions).toHaveLength(1);
  });
});

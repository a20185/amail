import { describe, expect, it } from "vitest";
import { WorkspaceEventSchema } from "./workspace.js";

const base = {
  seq: 3,
  eventId: "we_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
  actor: "alice@mbp16",
  at: "2026-10-27T09:00:00.000Z",
  sig: "c2ln",
};

describe("WorkspaceEventSchema", () => {
  it("eventId 前缀为 we_（契约）；evt_ 旧前缀拒绝", () => {
    const ev = { ...base, kind: "action", payload: { who: "alice@mbp16", content: "x", cc: [] } };
    expect(WorkspaceEventSchema.safeParse(ev).success).toBe(true);
    expect(
      WorkspaceEventSchema.safeParse({ ...ev, eventId: "evt_01JD2YWBN5GQXJSQ9P7RJ3TBEM" }).success,
    ).toBe(false);
  });

  it("round-trips action", () => {
    const ev = {
      ...base,
      kind: "action",
      payload: {
        who: "alice@mbp16",
        content: "review contracts",
        cc: ["bob@thinkpadx1"],
      },
    };
    expect(WorkspaceEventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips todo", () => {
    const ev = {
      ...base,
      kind: "todo",
      payload: {
        id: "td_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
        title: "ship phase 0",
        priority: 1,
        dueRange: { from: "2026-10-28", to: "2026-10-30" },
        status: "todo",
      },
    };
    expect(WorkspaceEventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips artifact / membership / session.attach / session.detach", () => {
    const artifact = {
      ...base,
      kind: "artifact",
      payload: {
        artifactId: "art_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
        name: "report.pdf",
        mime: "application/pdf",
        size: 10,
        tags: [],
        sha256: "a".repeat(64),
      },
    };
    expect(WorkspaceEventSchema.parse(artifact)).toEqual(artifact);

    const membership = {
      ...base,
      kind: "membership",
      payload: { op: "add", member: "bob@thinkpadx1" },
    };
    expect(WorkspaceEventSchema.parse(membership)).toEqual(membership);

    const attach = {
      ...base,
      kind: "session.attach",
      payload: { sessionId: "s1", cli: "claude-code", cwd: "/tmp" },
    };
    expect(WorkspaceEventSchema.parse(attach)).toEqual(attach);

    const detach = {
      ...base,
      kind: "session.detach",
      payload: {
        sessionId: "s1",
        attachEventId: "we_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
      },
    };
    expect(WorkspaceEventSchema.parse(detach)).toEqual(detach);
  });

  it.each([
    [
      "unknown kind",
      { ...base, kind: "nope", payload: {} },
    ],
    [
      "action bad who",
      {
        ...base,
        kind: "action",
        payload: { who: "bad", content: "x", cc: [] },
      },
    ],
    [
      "action content too long",
      {
        ...base,
        kind: "action",
        payload: { who: "a@b", content: "x".repeat(1001), cc: [] },
      },
    ],
    [
      "todo bad priority",
      {
        ...base,
        kind: "todo",
        payload: {
          id: "td_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
          title: "t",
          priority: 4,
          status: "todo",
        },
      },
    ],
    [
      "todo bad status",
      {
        ...base,
        kind: "todo",
        payload: {
          id: "td_01JD2YWBN5GQXJSQ9P7RJ3TBEM",
          title: "t",
          priority: 0,
          status: "paused",
        },
      },
    ],
    [
      "session.attach bad cli",
      {
        ...base,
        kind: "session.attach",
        payload: { sessionId: "s1", cli: "cursor", cwd: "/tmp" },
      },
    ],
    [
      "session.detach bad attachEventId",
      {
        ...base,
        kind: "session.detach",
        payload: { sessionId: "s1", attachEventId: "not-an-event" },
      },
    ],
    [
      "missing payload",
      { ...base, kind: "action", payload: undefined },
    ],
  ])("rejects %s", (_l, bad) => {
    expect(() => WorkspaceEventSchema.parse(bad)).toThrow();
  });
});

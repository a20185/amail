import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { resolveDirs } from "../core/paths.js";
import { EventBus } from "../daemon/sse.js";
import { userAddress } from "../daemon/server.js";
import type { DaemonCore } from "../daemon/router.js";
import type { RawMirrorEvent } from "../contract/api.js";
import { createWorkspace, WorkspaceHost } from "../workspace/host.js";
import { makeEvent } from "../workspace/events.js";
import { attachableList, MirrorHub, MirrorSessions } from "./hub.js";
import type { MirrorAdapter, SessionMeta } from "./types.js";

function makeCore(): DaemonCore {
  const home = mkdtempSync(join(tmpdir(), "amail-hub-"));
  const dirs = resolveDirs({ AMAIL_HOME: home });
  const db = openStore(dirs.storePath);
  const identity = loadOrCreateIdentity(dirs);
  return { db, dirs, identity, bus: new EventBus() };
}

function raw(sessionId: string, text: string): RawMirrorEvent {
  return { t: new Date().toISOString(), sessionId, role: "assistant", text };
}

describe("MirrorHub: RawMirrorEvent → 工作区级 n → MirrorEvent", () => {
  it("跨会话共享同一工作区级单调 n；每会话独立缓冲；事件不落库", () => {
    const core = makeCore();
    const hub = new MirrorHub(core);
    const e1 = hub.ingest("ws_1", raw("s1", "a"));
    const e2 = hub.ingest("ws_1", raw("s2", "b"));
    const e3 = hub.ingest("ws_1", raw("s1", "c"));
    expect([e1.n, e2.n, e3.n]).toEqual([1, 2, 3]);
    expect(e1).toMatchObject({ sessionId: "s1", role: "assistant", text: "a" });
    expect(hub.hwm("ws_1")).toBe(3);

    expect(hub.snapshot("ws_1", "s1").map((e) => e.n)).toEqual([1, 3]);
    expect(hub.snapshot("ws_1", "s2").map((e) => e.n)).toEqual([2]);

    // 独立工作区序号互不影响
    expect(hub.ingest("ws_2", raw("s1", "other")).n).toBe(1);

    const rows = core.db
      .prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?")
      .get("ws_1") as { n: number };
    expect(rows.n).toBe(0);
  });

  it("高水位持久化于 meta 表 mirror_hwm:<wsId>，房主重启（新 hub）续号", () => {
    const core = makeCore();
    const first = new MirrorHub(core);
    first.ingest("ws_x", raw("s", "1"));
    first.ingest("ws_x", raw("s", "2"));
    const stored = core.db.prepare("SELECT value FROM meta WHERE key = ?").get("mirror_hwm:ws_x") as {
      value: string;
    };
    expect(stored.value).toBe("2");

    const restarted = new MirrorHub(core);
    expect(restarted.hwm("ws_x")).toBe(2);
    expect(restarted.ingest("ws_x", raw("s", "3")).n).toBe(3);
  });

  it("缓冲每会话各最近 500 条，互不挤占", () => {
    const core = makeCore();
    const hub = new MirrorHub(core);
    for (let i = 0; i < 505; i++) hub.ingest("ws_cap", raw("s1", `a${i}`));
    for (let i = 0; i < 3; i++) hub.ingest("ws_cap", raw("s2", `b${i}`));
    const s1 = hub.snapshot("ws_cap", "s1");
    expect(s1).toHaveLength(500);
    expect(s1[0]!.n).toBe(6);
    expect(s1.at(-1)!.n).toBe(505);
    expect(hub.snapshot("ws_cap", "s2").map((e) => e.text!)).toEqual(["b0", "b1", "b2"]);
  });

  it("subscribe 扇出；退订后不再收到", () => {
    const core = makeCore();
    const hub = new MirrorHub(core);
    const seen: number[] = [];
    const off = hub.subscribe("ws_f", (e) => seen.push(e.n));
    hub.ingest("ws_f", raw("s", "1"));
    off();
    hub.ingest("ws_f", raw("s", "2"));
    expect(seen).toEqual([1]);
  });

  it("detach 代际匹配：旧代 detach 不清新挂载的缓冲", () => {
    const core = makeCore();
    const hub = new MirrorHub(core);
    const wsId = createWorkspace(core, { name: "P7", projectSlug: "p7" });
    const host = new WorkspaceHost(core, wsId);
    const actor = userAddress(core.dirs, core.identity);
    const attachPayload = { sessionId: "s1", cli: "claude-code" as const, cwd: "/tmp/p7" };

    const attach1 = makeEvent(core.identity.signPrivPem, actor, "session.attach", attachPayload);
    host.submit(attach1);
    hub.ingest(wsId, raw("s1", "one"));

    const attach2 = makeEvent(core.identity.signPrivPem, actor, "session.attach", attachPayload);
    host.submit(attach2);
    expect(host.state().attached[0]!.attachEventId).toBe(attach2.eventId);

    host.submit(
      makeEvent(core.identity.signPrivPem, actor, "session.detach", {
        sessionId: "s1",
        attachEventId: attach1.eventId,
      }),
    );
    // 旧代迟到：投影与新流均不动
    expect(host.state().attached.map((a) => a.attachEventId)).toEqual([attach2.eventId]);
    expect(hub.snapshot(wsId, "s1")).toHaveLength(1);

    host.submit(
      makeEvent(core.identity.signPrivPem, actor, "session.detach", {
        sessionId: "s1",
        attachEventId: attach2.eventId,
      }),
    );
    expect(host.state().attached).toEqual([]);
    expect(hub.snapshot(wsId, "s1")).toEqual([]);
  });
});

describe("MirrorSessions: 活跃探针与代际断流", () => {
  it("mount 取代旧代（abort 旧 signal）；activeSessionIds 供幽灵清理探针", () => {
    const sessions = new MirrorSessions();
    const first = new AbortController();
    sessions.mount({
      workspaceId: "ws",
      sessionId: "s1",
      cli: "pi",
      attachEventId: "evt_old",
      abort: first,
    });
    expect([...sessions.activeSessionIds()]).toEqual(["s1"]);

    const second = new AbortController();
    sessions.mount({
      workspaceId: "ws",
      sessionId: "s1",
      cli: "pi",
      attachEventId: "evt_new",
      abort: second,
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    expect(sessions.stop("ws", "s1", "evt_old")).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(sessions.get("ws", "s1")?.attachEventId).toBe("evt_new");

    expect(sessions.stop("ws", "s1", "evt_new")).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(sessions.activeSessionIds().size).toBe(0);
  });
});

describe("attachableList", () => {
  it("合并各适配器 discover 结果", () => {
    const meta = (id: string, cli: SessionMeta["cli"]): SessionMeta => ({
      sessionId: id,
      cli,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
      mtime: new Date().toISOString(),
    });
    const adapter = (id: SessionMeta["cli"], ids: string[]): MirrorAdapter => ({
      id,
      discover: () => ids.map((x) => meta(x, id)),
      stream: async function* () {},
    });
    const list = attachableList([adapter("claude-code", ["a"]), adapter("pi", ["b", "c"])]);
    expect(list.map((s) => `${s.cli}:${s.sessionId}`)).toEqual(["claude-code:a", "pi:b", "pi:c"]);
  });
});

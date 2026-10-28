import { appendFileSync, cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../core/crypto.js";
import { resetDeliveryConfig } from "../../core/delivery.js";
import { amailSigHeaders, ensureSync, localState, stopSync } from "../../workspace/projection-local.js";
import { createWorkspace, getWorkspaceRow, WorkspaceHost } from "../../workspace/host.js";
import { makeEvent } from "../../workspace/events.js";
import { acceptInvite, type WorkspaceInvite } from "../../workspace/invite.js";
import type { MirrorEvent } from "../../contract/api.js";
import { pairDual, startDual, startNode, until, fakeMdns, ROUTES_DIR, type DualSandbox } from "../e2e-kit.js";
import { startDaemon, type DaemonHandle } from "../server.js";
import mirrorRoutes from "./mirror.js";

const CC_FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/mirror/claude-code", import.meta.url));
const SESSION_ID = "0b34d286-4903-4d93-be17-128b6b3d653e";

const handles: DaemonHandle[] = [];
const savedEnv = {
  cc: process.env.AMAIL_MIRROR_CC_ROOT,
  pi: process.env.AMAIL_MIRROR_PI_ROOT,
  oc: process.env.AMAIL_MIRROR_OC_ROOT,
};

afterEach(async () => {
  const saved: Record<string, string | undefined> = {
    AMAIL_MIRROR_CC_ROOT: savedEnv.cc,
    AMAIL_MIRROR_PI_ROOT: savedEnv.pi,
    AMAIL_MIRROR_OC_ROOT: savedEnv.oc,
  };
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDeliveryConfig();
  for (const handle of handles.splice(0)) await handle.stop();
});

interface Fixture {
  root: string;
  file: string;
}

/** fixture 脱敏拷贝到临时根；本机真实 HOME 不被读取（三根全部注入） */
function setupFixtureRoots(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "amail-mirror-e2e-"));
  cpSync(CC_FIXTURE, join(root, "cc"), { recursive: true });
  const slugDir = readdirSync(join(root, "cc", "projects"))[0]!;
  const file = join(root, "cc", "projects", slugDir, `${SESSION_ID}.jsonl`);
  process.env.AMAIL_MIRROR_CC_ROOT = join(root, "cc");
  process.env.AMAIL_MIRROR_PI_ROOT = join(root, "no-pi");
  process.env.AMAIL_MIRROR_OC_ROOT = join(root, "no-oc");
  return { root, file };
}

/** 以 handle 本机身份签署请求（pathname 不含 query） */
async function signedFetch(
  handle: DaemonHandle,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return signedFetchTo(handle, handle, path, init);
}

/** 以 signer 身份签署、打到 target 节点（成员→房主的 LAN 请求） */
async function signedFetchTo(
  signer: DaemonHandle,
  target: DaemonHandle,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  return fetch(`http://127.0.0.1:${target.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(signer.identity.signPrivPem, method, pathname, bodyText, signer.address),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
}

interface SsePump {
  events: MirrorEvent[];
  close: () => Promise<void>;
}

async function openMirrorSse(handle: DaemonHandle, wsId: string, after: number): Promise<SsePump> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${handle.port}/ws/${wsId}/mirror?after=${after}`, {
    headers: {
      accept: "text/event-stream",
      ...amailSigHeaders(handle.identity.signPrivPem, "GET", `/ws/${wsId}/mirror`, "", handle.address),
    },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const events: MirrorEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            events.push(JSON.parse(line.slice(6)) as MirrorEvent);
          }
        }
      }
    } catch {
      // abort → 正常结束
    }
  })();

  return {
    events,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

interface AuditRow {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

function auditRows(handle: DaemonHandle, wsId: string): AuditRow[] {
  const rows = handle.db
    .prepare("SELECT event_json FROM workspace_events WHERE workspace_id = ? ORDER BY seq")
    .all(wsId) as unknown as { event_json: string }[];
  return rows.map((r) => JSON.parse(r.event_json) as AuditRow);
}

describe("mirror routes: 双节点显式 attach → 上行 → SSE 扇出", () => {
  it(
    "成员 attach 审计恰一条；B 消费序（订阅→snapshot→n 去重）不丢事件；cursor-stale 409；detach 后静默；镜像数据不落库",
    async () => {
      const fixture = setupFixtureRoots();
      const sandbox: DualSandbox = await startDual("amail-mirror-");
      const { a, b } = sandbox;
      handles.push(a, b);
      await pairDual(sandbox);
      const wsId = createWorkspace(a, { name: "Mirror", projectSlug: "mirror" });

      const invite = (await (
        await signedFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })
      ).json()) as WorkspaceInvite;
      await acceptInvite(b.dirs, invite);

      // daemon 运行中 acceptInvite 即时启动同步（无需重启 daemon）
      expect(await until(() => localState(b.db, wsId).members.includes(b.address))).toBe(true);
      const early = await signedFetch(a, `/ws/${wsId}/events`, {
        method: "POST",
        body: makeEvent(a.identity.signPrivPem, a.address, "action", {
          who: a.address,
          content: "pre-attach",
          cc: [],
        }),
      });
      expect(early.status).toBe(201);
      expect(
        await until(() => localState(b.db, wsId).actions.some((x) => x.payload.content === "pre-attach")),
      ).toBe(true);

      // 本机可挂载会话（member 侧经本机 daemon 的适配器发现）
      const attachable = (await (await signedFetch(b, `/ws/${wsId}/mirror/attachable`)).json()) as {
        sessions: Array<{ sessionId: string; cli: string }>;
      };
      expect(attachable.sessions.map((s) => `${s.cli}:${s.sessionId}`)).toEqual([`claude-code:${SESSION_ID}`]);

      // ① 先建 SSE 订阅（连接即开始缓冲）
      const sse = await openMirrorSse(a, wsId, 0);

      // ② attach：成员经本机 daemon；审计事件上行房主
      const attachRes = await signedFetch(b, `/ws/${wsId}/mirror/attach`, {
        method: "POST",
        body: { sessionId: SESSION_ID, cli: "claude-code" },
      });
      expect(attachRes.status).toBe(201);
      const attached = (await attachRes.json()) as { attachEventId: string; seq: number };
      expect(attached.attachEventId).toMatch(/^we_/);

      // 事件完整到达（4 条 fixture 存量 → 工作区级 n 连续）
      expect(await until(() => sse.events.length >= 4)).toBe(true);
      expect(sse.events.map((e) => e.n)).toEqual([1, 2, 3, 4]);
      expect(new Set(sse.events.map((e) => e.sessionId))).toEqual(new Set([SESSION_ID]));
      expect(sse.events[0]!.text).toBe("[Request interrupted by user]");
      expect(sse.events[1]!.path).toContain("inference-rules-v3.md");
      expect(sse.events[2]!.path).toContain("ts6-structural-analysis-v2.md");
      expect(sse.events[3]!.path).toContain("analysis.ipynb");

      // ③ snapshot 当前缓冲全量；按工作区级 n 去重合并无重复
      const snap = (await (await signedFetch(a, `/ws/${wsId}/mirror/${SESSION_ID}/snapshot`)).json()) as {
        events: MirrorEvent[];
        hwm: number;
      };
      expect(snap.hwm).toBe(4);
      expect(snap.events.map((e) => e.n)).toEqual([1, 2, 3, 4]);
      const merged = new Map<number, MirrorEvent>();
      for (const ev of [...snap.events, ...sse.events]) merged.set(ev.n, ev);
      expect([...merged.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);

      // 审计事件恰一条落 workspace_events；镜像事件不落库
      const audit = auditRows(a, wsId);
      expect(audit.filter((e) => e.kind === "session.attach")).toHaveLength(1);
      expect(audit.filter((e) => e.kind === "session.detach")).toHaveLength(0);
      const attachAudit = audit.find((e) => e.kind === "session.attach")!;
      expect(attachAudit.payload).toMatchObject({ sessionId: SESSION_ID, cli: "claude-code" });
      const textEvent = audit.some((e) => e.payload.text !== undefined || e.payload.after !== undefined);
      expect(textEvent).toBe(false);
      expect(
        a.db
          .prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND event_json LIKE ?")
          .get(wsId, "%inference-rules%"),
      ).toEqual({ n: 0 });

      // cursor-stale：after > 当前 hwm → 409 重置
      const stale = await signedFetch(a, `/ws/${wsId}/mirror?after=99`);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "cursor-stale", hwm: 4 });

      // 尾随：fixture 追加一行 → 2s 内到达新 n
      const live = {
        cwd: "/Users/souler/Test",
        sessionId: SESSION_ID,
        timestamp: "2026-09-09T12:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "live mirror text" }] },
      };
      appendFileSync(fixture.file, `${JSON.stringify(live)}\n`);
      expect(await until(() => sse.events.length >= 5)).toBe(true);
      expect(sse.events[4]).toMatchObject({ n: 5, sessionId: SESSION_ID, text: "live mirror text" });

      // 纯实时不回放：after ≤ hwm 的旧游标不收到存量（仅过滤起点，无下界门槛）
      const staleCursor = await openMirrorSse(a, wsId, 2);
      // 观测窗口：验证“不回放”必须有界等待
      await new Promise((r) => setTimeout(r, 250));
      expect(staleCursor.events).toEqual([]);
      await staleCursor.close();

      // 幽灵清理（触发点②：补拉后兜底）：无活跃采集流的残留 attach 被清理，
      // 活跃挂载（configureActiveSessions 探针注入）不被误摘
      const ghost = makeEvent(b.identity.signPrivPem, b.address, "session.attach", {
        sessionId: "ghost-session",
        cli: "claude-code",
        cwd: "/tmp/ghost",
      });
      expect((await signedFetchTo(b, a, `/ws/${wsId}/events`, { method: "POST", body: ghost })).status).toBe(201);
      stopSync(wsId);
      ensureSync(b, getWorkspaceRow(b.db, wsId)!);
      expect(
        await until(() =>
          auditRows(a, wsId).some((e) => e.kind === "session.detach" && e.payload.sessionId === "ghost-session"),
        ),
      ).toBe(true);
      expect(new WorkspaceHost(a, wsId).state().attached.map((x) => x.sessionId)).toEqual([SESSION_ID]);

      // detach（携当前挂载 attachEventId）→ 审计一条 → 缓冲清除 → 后续追加静默
      const detachRes = await signedFetch(b, `/ws/${wsId}/mirror/${SESSION_ID}`, { method: "DELETE" });
      expect(detachRes.status).toBe(200);
      expect(
        await until(
          () =>
            auditRows(a, wsId).filter((e) => e.kind === "session.detach" && e.payload.sessionId === SESSION_ID)
              .length === 1,
        ),
      ).toBe(true);
      expect(
        await until(
          async () =>
            (await (await signedFetch(a, `/ws/${wsId}/mirror/${SESSION_ID}/snapshot`)).json() as {
              events: unknown[];
            }).events.length === 0,
        ),
      ).toBe(true);

      const beforeSilence = sse.events.length;
      appendFileSync(
        fixture.file,
        `${JSON.stringify({ ...live, timestamp: "2026-09-09T12:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "after detach" }] } })}\n`,
      );
      // 观测窗口：验证“无事件”必须有界等待（真实时钟，非确定性控制点）
      await new Promise((r) => setTimeout(r, 1_200));
      expect(sse.events.length).toBe(beforeSilence);

      const finalAudit = auditRows(a, wsId);
      expect(finalAudit.some((e) => e.payload.text === "after detach")).toBe(false);

      await sse.close();
    },
    20_000,
  );
});

/** 双节点 + 配对 + 建区 + 邀请 B 入区 */
async function memberWorkspace(tag: string): Promise<DualSandbox & { wsId: string }> {
  const sandbox = await startDual(tag);
  handles.push(sandbox.a, sandbox.b);
  await pairDual(sandbox);
  const wsId = createWorkspace(sandbox.a, { name: "Mirror", projectSlug: "mirror" });
  const invite = (await (
    await signedFetch(sandbox.a, `/ws/${wsId}/invite`, { method: "POST", body: {} })
  ).json()) as WorkspaceInvite;
  await acceptInvite(sandbox.b.dirs, invite);
  return { ...sandbox, wsId };
}

describe("mirror routes: 回环专属面与上行归属", () => {
  it("attachable/attach/detach 为 lan:false；SSE/snapshot/上行保留 LAN", () => {
    const flags = Object.fromEntries(mirrorRoutes.map((r) => [`${r.method} ${r.path}`, r.lan]));
    expect(flags["GET /ws/:id/mirror/attachable"]).toBe(false);
    expect(flags["POST /ws/:id/mirror/attach"]).toBe(false);
    expect(flags["DELETE /ws/:id/mirror/:sessionId"]).toBe(false);
    expect(flags["GET /ws/:id/mirror"]).toBe(true);
    expect(flags["GET /ws/:id/mirror/:sessionId/snapshot"]).toBe(true);
    expect(flags["POST /ws/:id/mirror/:sessionId/event"]).toBe(true);
  });

  it("上行归属：非挂载发起者 409 且不落缓冲；detach 后迟到事件 409 且不重建缓冲", async () => {
    const { a, b, wsId } = await memberWorkspace("amail-mirror-own-");

    // 房主本机挂载 s1（审计事件；测试无需真实适配器）
    const attach = makeEvent(a.identity.signPrivPem, a.address, "session.attach", {
      sessionId: "s1",
      cli: "claude-code",
      cwd: "/tmp",
    });
    const attached = await signedFetch(a, `/ws/${wsId}/events`, { method: "POST", body: attach });
    expect(attached.status).toBe(201);

    const raw = { t: new Date().toISOString(), sessionId: "s1", text: "injected" };
    const injected = await signedFetchTo(b, a, `/ws/${wsId}/mirror/s1/event`, {
      method: "POST",
      body: raw,
    });
    expect(injected.status).toBe(409);
    expect(((await injected.json()) as { error: string }).error).toBe("not-attached");

    const snap = (await (
      await signedFetchTo(b, a, `/ws/${wsId}/mirror/s1/snapshot`)
    ).json()) as { events: unknown[]; hwm: number };
    expect(snap.events).toEqual([]);
    expect(snap.hwm).toBe(0);

    // 房主 detach → 迟到上行 409，不得重建缓冲
    const detach = makeEvent(a.identity.signPrivPem, a.address, "session.detach", {
      sessionId: "s1",
      attachEventId: attach.eventId,
    });
    expect((await signedFetch(a, `/ws/${wsId}/events`, { method: "POST", body: detach })).status).toBe(201);

    const late = await signedFetchTo(b, a, `/ws/${wsId}/mirror/s1/event`, {
      method: "POST",
      body: { ...raw, text: "late" },
    });
    expect(late.status).toBe(409);
    const snapAfter = (await (
      await signedFetchTo(b, a, `/ws/${wsId}/mirror/s1/snapshot`)
    ).json()) as { events: unknown[]; hwm: number };
    expect(snapAfter.events).toEqual([]);
    expect(snapAfter.hwm).toBe(0);
  });

  it("房主崩溃重启：启动清理自身幽灵挂载（提交 detach，缓冲不复活）", async () => {
    const a = await startNode("amail-mirror-ghost-a-", "Alice");
    handles.push(a);
    const wsId = createWorkspace(a, { name: "Mirror", projectSlug: "mirror" });
    const attach = makeEvent(a.identity.signPrivPem, a.address, "session.attach", {
      sessionId: "s1",
      cli: "claude-code",
      cwd: "/tmp",
    });
    expect((await signedFetch(a, `/ws/${wsId}/events`, { method: "POST", body: attach })).status).toBe(201);
    expect(new WorkspaceHost(a, wsId).state().attached.map((x) => x.sessionId)).toEqual(["s1"]);

    const dirs = a.dirs;
    await a.stop();
    handles.pop();

    const revived = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
    handles.push(revived);

    expect(new WorkspaceHost(revived, wsId).state().attached).toEqual([]);
    const detaches = auditRows(revived, wsId).filter((e) => e.kind === "session.detach");
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.payload).toMatchObject({ sessionId: "s1", attachEventId: attach.eventId });
  });
});

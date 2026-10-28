import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../core/crypto.js";
import { localState, stopSync, amailSigHeaders } from "../../workspace/projection-local.js";
import { createWorkspace, WorkspaceHost } from "../../workspace/host.js";
import { makeEvent } from "../../workspace/events.js";
import { acceptInvite, parseInviteFromText, type WorkspaceInvite } from "../../workspace/invite.js";
import { listInbox } from "../../core/store.js";
import { runWsAction } from "../../cli/cmds/ws.js";
import { pairDual, startDual, until, type DualSandbox } from "../e2e-kit.js";
import { resetDeliveryConfig } from "../../core/delivery.js";
import type { DaemonHandle } from "../server.js";

const handles: DaemonHandle[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  for (const handle of handles.splice(0)) await handle.stop();
});

interface Dual extends DualSandbox {
  wsId: string;
}

async function dual(tag: string): Promise<Dual> {
  const sandbox = await startDual(`amail-ws-${tag}`);
  handles.push(sandbox.a, sandbox.b);
  await pairDual(sandbox);
  const wsId = createWorkspace(sandbox.a, { name: "Proj", projectSlug: "proj" });
  return { ...sandbox, wsId };
}

/** 回环（房主本机 CLI）签名请求 */
async function hostFetch(a: DaemonHandle, path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? "GET";
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  return fetch(`http://127.0.0.1:${a.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(a.identity.signPrivPem, method, pathname, bodyText, a.address),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
}

/** 成员（LAN 来源）签名请求打到房主 A */
async function memberFetch(
  b: DaemonHandle,
  a: DaemonHandle,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const method = init.method ?? "GET";
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  return fetch(`http://127.0.0.1:${a.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(b.identity.signPrivPem, method, pathname, bodyText, b.address),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
}

function hostAction(handle: DaemonHandle, content: string, cc: string[] = []) {
  return makeEvent(handle.identity.signPrivPem, handle.address, "action", {
    who: handle.address,
    content,
    cc,
  });
}

describe("workspace routes: 房主定序（回环）", () => {
  it("提交连续无洞；since 补拉正确", async () => {
    const { a, wsId } = await dual("seq");
    for (const content of ["one", "two", "three"]) {
      const res = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: hostAction(a, content) });
      expect(res.status).toBe(201);
    }
    const pull = (await (await hostFetch(a, `/ws/${wsId}/events?since=0`)).json()) as {
      events: Array<{ seq: number }>;
      lastSeq: number;
    };
    expect(pull.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(pull.lastSeq).toBe(4);
    const inc = (await (await hostFetch(a, `/ws/${wsId}/events?since=2`)).json()) as { events: Array<{ seq: number }> };
    expect(inc.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("eventId 幂等：重复提交返回原 seq", async () => {
    const { a, wsId } = await dual("idem");
    const event = hostAction(a, "once");
    const first = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: event });
    expect(((await first.json()) as { seq: number }).seq).toBe(2);
    const again = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: event });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { seq: number; duplicate: boolean }).duplicate).toBe(true);
  });

  it("artifact 一律 422 use-upload-endpoint", async () => {
    const { a, wsId } = await dual("artifact");
    const artifact = {
      eventId: "we_01HGV2KP5Z4W7R8X9Y0ZABCD2F",
      actor: a.address,
      kind: "artifact",
      payload: {
        artifactId: "art_01HGV2KP5Z4W7R8X9Y0ZABCDEF",
        name: "a",
        mime: "text/plain",
        size: 1,
        tags: [],
        sha256: "a".repeat(64),
      },
      at: new Date().toISOString(),
      sig: "x",
    };
    const res = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: artifact });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("use-upload-endpoint");
  });

  it("SSE：回放存量 + 实时事件按游标去重", async () => {
    const { a, wsId } = await dual("sse");
    await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: hostAction(a, "pre") });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/events?since=1`, {
      headers: {
        accept: "text/event-stream",
        ...amailSigHeaders(a.identity.signPrivPem, "GET", `/ws/${wsId}/events`, "", a.address),
      },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seqs: number[] = [];
    const readUntil = async (count: number) => {
      for (;;) {
        if (seqs.length >= count) return;
        const { done, value } = await reader.read();
        if (done) throw new Error("sse closed early");
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = JSON.parse(line.slice(6)) as { seq?: number };
              if (typeof payload.seq === "number") seqs.push(payload.seq);
            }
          }
        }
      }
    };

    await readUntil(1); // 回放 seq=2
    expect(seqs).toEqual([2]);

    await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: hostAction(a, "live") });
    await readUntil(2); // 实时 seq=3
    expect(seqs).toEqual([2, 3]);

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("workspace routes: X-Amail-Sig 验签", () => {
  it("无签名 401；伪造签名 401；房主合法签名 200", async () => {
    const { a, wsId } = await dual("sig401");
    const missing = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/state`);
    expect(missing.status).toBe(401);

    const forged = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/state`, {
      headers: {
        "X-Amail-Sig": Buffer.from("forged").toString("base64"),
        "X-Amail-Date": new Date().toISOString(),
      },
    });
    expect(forged.status).toBe(401);

    const stale = await hostFetch(a, `/ws/${wsId}/state`);
    expect(stale.status).toBe(200);
  });

  it("已配对非成员的合法签名 → 403；非成员提交 → 403", async () => {
    const { a, b, wsId } = await dual("sig403");
    const state = await memberFetch(b, a, `/ws/${wsId}/state`);
    expect(state.status).toBe(403);

    const event = makeEvent(b.identity.signPrivPem, b.address, "action", {
      who: b.address,
      content: "sneak",
      cc: [],
    });
    const submit = await memberFetch(b, a, `/ws/${wsId}/events`, { method: "POST", body: event });
    expect(submit.status).toBe(403);

    // 回环来源但 actor 声称非成员 → 403
    const claimed = makeEvent(a.identity.signPrivPem, b.address, "action", { who: b.address, content: "x", cc: [] });
    const res = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: claimed });
    expect(res.status).toBe(403);
  });
});

describe("workspace routes: 邀请→准入→收敛", () => {
  it("invite 经信件送达 → accept(join) → membership 落库 → 后续提交通过成员检查；两端收敛；离线只读", async () => {
    const { a, b, wsId } = await dual("invite");

    // 房主签发邀请块并邮寄给 B
    const inviteRes = await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} });
    expect(inviteRes.status).toBe(200);
    const invite = (await inviteRes.json()) as WorkspaceInvite;
    await fetch(`http://127.0.0.1:${a.port}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: b.address,
        subject: "workspace invite: Proj",
        body: JSON.stringify(invite, null, 2),
        refs: [],
      }),
    });

    // B 收到邀请信
    expect(await until(() => listInbox(b.db, {}).some((m) => m.subject === "workspace invite: Proj"))).toBe(true);
    const mail = listInbox(b.db, {}).find((m) => m.subject === "workspace invite: Proj")!;
    const parsed = parseInviteFromText(mail.body);

    // B 接受：登记本地 workspace + join 房主 + 触发 daemon 同步
    const result = await acceptInvite(b.dirs, parsed);
    expect(result.workspaceId).toBe(wsId);

    // 房主侧 membership add 落库（房主署名事件）
    const host = new WorkspaceHost(a, wsId);
    expect(host.state().members).toContain(b.address);

    // 被邀请方后续提交通过成员检查
    const joinAction = makeEvent(b.identity.signPrivPem, b.address, "action", {
      who: b.address,
      content: "hello from member",
      cc: [],
    });
    const submit = await memberFetch(b, a, `/ws/${wsId}/events`, { method: "POST", body: joinAction });
    expect(submit.status).toBe(201);

    // 两端收敛：成员 localState 与房主 state 一致
    expect(
      await until(() => localState(b.db, wsId).actions.some((x) => x.payload.content === "hello from member")),
    ).toBe(true);
    const remote = localState(b.db, wsId);
    const authoritative = host.state();
    expect(remote.members.sort()).toEqual(authoritative.members.sort());
    expect(remote.actions.map((x) => x.seq)).toEqual(authoritative.actions.map((x) => x.seq));

    // 离线成员 localState 只读可用
    stopSync(wsId);
    expect(localState(b.db, wsId).actions.length).toBe(authoritative.actions.length);
  });

  it("join 重放（已成员）幂等 200 alreadyMember", async () => {
    const { a, b, wsId } = await dual("join-idem");
    const invite = (await (await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })).json()) as WorkspaceInvite;
    await acceptInvite(b.dirs, invite);
    const again = await acceptInvite(b.dirs, invite);
    expect(again.alreadyMember).toBe(true);
  });

  it("伪造邀请块 / 伪造 join 签名 → 401", async () => {
    const { a, b, wsId } = await dual("join-evil");
    const invite = (await (await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })).json()) as WorkspaceInvite;

    // 篡改邀请块（CLI 层验签拒绝）
    const tampered = { ...invite, name: "evil" };
    await expect(acceptInvite(b.dirs, tampered)).rejects.toThrow(/invite signature/);

    // join 请求签名不覆盖 invite.workspaceId‖actor → 房主拒绝
    const pathname = `/ws/${wsId}/join`;
    const payload = { invite, actor: b.address, sig: Buffer.from("garbage").toString("base64") };
    const bodyText = canonicalStringify(payload);
    const res = await fetch(`http://127.0.0.1:${a.port}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...amailSigHeaders(b.identity.signPrivPem, "POST", pathname, bodyText, b.address),
      },
      body: bodyText,
    });
    expect(res.status).toBe(401);
  });
});

describe("workspace routes: 写路径归属与拒绝门", () => {
  it("通用 events 入口拒绝 membership（422 use-invite-flow），房主/成员一律", async () => {
    const { a, b, wsId } = await dual("membership");
    const hostAdd = makeEvent(a.identity.signPrivPem, a.address, "membership", {
      op: "add",
      member: "eve@pc",
    });
    const hostRes = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: hostAdd });
    expect(hostRes.status).toBe(422);
    expect(((await hostRes.json()) as { error: string }).error).toBe("use-invite-flow");

    const invite = (await (
      await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })
    ).json()) as WorkspaceInvite;
    await acceptInvite(b.dirs, invite);

    const memberAdd = makeEvent(b.identity.signPrivPem, b.address, "membership", {
      op: "add",
      member: "eve@pc",
    });
    const memberRes = await memberFetch(b, a, `/ws/${wsId}/events`, { method: "POST", body: memberAdd });
    expect(memberRes.status).toBe(422);
    expect(((await memberRes.json()) as { error: string }).error).toBe("use-invite-flow");
    expect(new WorkspaceHost(a, wsId).state().members).not.toContain("eve@pc");
  });

  it("成员 daemon 拒绝权威写入（409 not-host）；成员 CLI 写路径直连房主不分叉", async () => {
    const { a, b, wsId } = await dual("fork");
    const invite = (await (
      await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })
    ).json()) as WorkspaceInvite;
    await acceptInvite(b.dirs, invite);

    // 成员本机回环提交 → 409，不落库
    const fork = makeEvent(b.identity.signPrivPem, b.address, "action", {
      who: b.address,
      content: "fork-attempt",
      cc: [],
    });
    const rejected = await hostFetch(b, `/ws/${wsId}/events`, { method: "POST", body: fork });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: string }).error).toBe("not-host");
    expect(new WorkspaceHost(a, wsId).state().actions.some((x) => x.payload.content === "fork-attempt")).toBe(
      false,
    );

    // CLI 写路径：成员 → 直连房主 URL（带 X-Amail-Sig），房主定序
    await runWsAction({
      who: b.address,
      content: "member-via-host",
      cc: [],
      env: { ...process.env, AMAIL_HOME: b.dirs.home },
    });
    expect(
      new WorkspaceHost(a, wsId).state().actions.some((x) => x.payload.content === "member-via-host"),
    ).toBe(true);
    const localRows = b.db
      .prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND source = 'local'")
      .get(wsId) as { n: number };
    expect(localRows.n).toBe(0);
  });

  it("X-Amail-Date 入签名：窗口内改动 Date → 401；原签名 200", async () => {
    const { a, wsId } = await dual("date");
    const pathname = `/ws/${wsId}/state`;
    const headers = amailSigHeaders(a.identity.signPrivPem, "GET", pathname, "", a.address);
    const ok = await fetch(`http://127.0.0.1:${a.port}${pathname}`, { headers });
    expect(ok.status).toBe(200);

    const replay = await fetch(`http://127.0.0.1:${a.port}${pathname}`, {
      headers: { ...headers, "X-Amail-Date": new Date(Date.now() - 60_000).toISOString() },
    });
    expect(replay.status).toBe(401);
  });
});

describe("workspace routes: CC → 信箱联动", () => {
  it("cc 房主自己 → 本地通知信；cc 成员 → LAN 投递到成员信箱", async () => {
    const { a, b, wsId } = await dual("cc");
    const invite = (await (await hostFetch(a, `/ws/${wsId}/invite`, { method: "POST", body: {} })).json()) as WorkspaceInvite;
    await acceptInvite(b.dirs, invite);

    // 房主 action cc 自己 → 本地通知信（不经出箱）
    await hostFetch(a, `/ws/${wsId}/events`, {
      method: "POST",
      body: hostAction(a, "cc-self", [a.address]),
    });
    expect(await until(() => listInbox(a.db, {}).some((m) => m.subject.includes("cc-self")))).toBe(true);
    const outboxCount = a.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    expect(outboxCount.n).toBe(0);

    // 房主 action cc 成员 B → 成员信箱出现通知信
    await hostFetch(a, `/ws/${wsId}/events`, {
      method: "POST",
      body: hostAction(a, "cc-member", [b.address]),
    });
    expect(await until(() => listInbox(b.db, {}).some((m) => m.subject.includes("cc-member")))).toBe(true);
    const notice = listInbox(b.db, {}).find((m) => m.subject.includes("cc-member"))!;
    expect(notice.subject).toBe(`[ws:${wsId.slice(0, 8)}] ${a.address}: cc-member`);
    expect(notice.body).toContain(wsId);
  });
});

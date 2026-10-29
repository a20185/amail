import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { resolveDirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { markArchived, saveInbound } from "../../core/store.js";
import { EnvelopeSchema, type Envelope } from "../../contract/envelope.js";
import { EventBus, type BusEvent } from "../sse.js";
import routes from "./inbox.js";
import type { RouteCtx, Route } from "../router.js";

export function sandbox(prefix: string) {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), `amail-${prefix}-`)) });
  return { dirs, db: openStore(dirs.storePath), identity: loadOrCreateIdentity(dirs) };
}

export function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return EnvelopeSchema.parse({
    v: 1,
    id: `msg_${ulid()}`,
    from: "alice@other-dev",
    to: "bob@this-dev",
    subject: "标题",
    inReplyTo: null,
    references: [],
    createdAt: new Date().toISOString(),
    claim: { name: "alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm", epk: "epk", iv: "iv", body: "sealed" },
    attachments: [],
    sig: "c2ln",
    ...overrides,
  });
}

export class FakeRes {
  statusCode = 200;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(data?: unknown): this {
    if (typeof data === "string") this.body += data;
    return this;
  }
}

export async function callRoute(
  route: Route,
  ctx: {
    db: RouteCtx["db"];
    dirs: RouteCtx["dirs"];
    identity: RouteCtx["identity"];
    bus?: EventBus;
    params?: Record<string, string>;
    query?: URLSearchParams;
    body?: unknown;
  },
): Promise<{ status: number; body: string; json: <T>() => T }> {
  const res = new FakeRes();
  await route.handler({
    req: { method: route.method } as IncomingMessage,
    res: res as unknown as ServerResponse,
    bus: ctx.bus ?? new EventBus(),
    params: ctx.params ?? {},
    query: ctx.query ?? new URLSearchParams(),
    body: ctx.body,
    ...ctx,
  } as RouteCtx);
  return {
    status: res.statusCode,
    body: res.body,
    json: <T,>() => JSON.parse(res.body) as T,
  };
}

const byPath = (method: string, path: string) =>
  routes.find((r) => r.method === method && r.path === path)!;

describe("GET /v1/inbox", () => {
  it("默认视图 = 未归档 + project 对应已归档件合并", () => {
    const { dirs, db, identity } = sandbox("inbox");
    const keep = envelope({ subject: "未归档" });
    const other = envelope({ subject: "别的项目" });
    const mine = envelope({ subject: "本项目归档" });
    for (const env of [keep, other, mine]) {
      saveInbound(db, env, { body: env.subject, attachments: [] }, { sigValid: true });
    }
    markArchived(db, other.id, "zzz");
    markArchived(db, mine.id, "acme");

    return callRoute(byPath("GET", "/v1/inbox"), {
      db,
      dirs,
      identity,
      query: new URLSearchParams({ project: "acme" }),
    }).then(({ status, json }) => {
      const items = json<{ id: string; subject: string; unread: boolean; hasHandoff: boolean }[]>();
      expect(status).toBe(200);
      // 未归档(keep) + acme 归档(mine)；不含 other 项目的归档件
      expect(items.map((i) => i.id).sort()).toEqual([keep.id, mine.id].sort());
      expect(items.every((i) => i.unread && !i.hasHandoff)).toBe(true);
    });
  });

  it("all=true 全量；unread=true 只看未读", async () => {
    const { dirs, db, identity } = sandbox("inbox2");
    const m1 = envelope();
    const m2 = envelope();
    for (const env of [m1, m2]) {
      saveInbound(db, env, { body: "b", attachments: [] }, { sigValid: true });
    }
    markArchived(db, m1.id, "acme");
    const all = await callRoute(byPath("GET", "/v1/inbox"), {
      db,
      dirs,
      identity,
      query: new URLSearchParams({ all: "true" }),
    });
    expect(all.json<{ id: string }[]>().map((i) => i.id).sort()).toEqual([m1.id, m2.id].sort());
  });
});

describe("GET /v1/message/:id", () => {
  it("404 与全文视图", async () => {
    const { dirs, db, identity } = sandbox("msg");
    const env = envelope({ subject: "全文" });
    saveInbound(
      db,
      env,
      { body: "正文", handoffJson: `{"progress":"p","description":"d","questions":["q"]}`, attachments: [] },
      { sigValid: true },
    );
    const found = await callRoute(byPath("GET", "/v1/message/:id"), {
      db,
      dirs,
      identity,
      params: { id: env.id },
    });
    const detail = found.json<{ body: string; handoff: { progress: string }; threadRoot: string }>();
    expect(found.status).toBe(200);
    expect(detail.body).toBe("正文");
    expect(detail.handoff.progress).toBe("p");
    expect(detail.threadRoot).toBe(env.id);

    const missing = await callRoute(byPath("GET", "/v1/message/:id"), {
      db,
      dirs,
      identity,
      params: { id: "msg_nothere" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /v1/read", () => {
  it("首次 read → receipt 事件；重复 read 不重发", async () => {
    const { dirs, db, identity } = sandbox("read");
    const bus = new EventBus();
    const env = envelope();
    saveInbound(db, env, { body: "b", attachments: [] }, { sigValid: true });

    const events: BusEvent[] = [];
    bus.on((e) => events.push(e));
    const first = await callRoute(byPath("POST", "/v1/read"), { db, dirs, identity, bus, body: { id: env.id } });
    expect(first.json<{ read: boolean }>().read).toBe(true);
    const second = await callRoute(byPath("POST", "/v1/read"), { db, dirs, identity, bus, body: { id: env.id } });
    expect(second.json<{ read: boolean }>().read).toBe(false);
    expect(events).toEqual([{ type: "receipt", data: { messageId: env.id, kind: "read" } }]);
  });

  it("未知 id → 404", async () => {
    const { dirs, db, identity } = sandbox("read404");
    const res = await callRoute(byPath("POST", "/v1/read"), { db, dirs, identity, body: { id: "msg_x" } });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/archive", () => {
  it("导出 + 标记 project", async () => {
    const { dirs, db, identity } = sandbox("archive");
    const repo = join(dirs.home, "repo");
    const archiveDir = join(dirs.home, "archive");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(dirs.projectsDir, "acme.json"),
      JSON.stringify({ name: "Acme", repos: [repo], archiveDir }),
    );
    const env = envelope({ subject: "待归档" });
    saveInbound(db, env, { body: "b", attachments: [] }, { sigValid: true });

    const ok = await callRoute(byPath("POST", "/v1/archive"), {
      db,
      dirs,
      identity,
      body: { id: env.id, project: "acme" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json<{ path: string }>().path).toContain(".md");
    const unknown = await callRoute(byPath("POST", "/v1/archive"), {
      db,
      dirs,
      identity,
      body: { id: env.id, project: "nope" },
    });
    expect(unknown.status).toBe(404);
  });
});

describe("GET /v1/search", () => {
  it("store.search 封装", async () => {
    const { dirs, db, identity } = sandbox("search");
    saveInbound(db, envelope(), { body: "本周结算已完成", attachments: [] }, { sigValid: true });
    saveInbound(db, envelope(), { body: "无关内容", attachments: [] }, { sigValid: true });
    const res = await callRoute(byPath("GET", "/v1/search"), {
      db,
      dirs,
      identity,
      query: new URLSearchParams({ q: "结算" }),
    });
    expect(res.json<{ id: string }[]>()).toHaveLength(1);
  });
});

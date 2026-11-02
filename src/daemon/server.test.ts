import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { resolveDirs } from "../core/paths.js";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { saveInbound } from "../core/store.js";
import { AliveInfoSchema } from "../contract/api.js";
import { EnvelopeSchema, type Envelope } from "../contract/envelope.js";
import { DaemonAlreadyRunningError, loadUserConfig, startDaemon, type DaemonHandle } from "./server.js";
import { fakeMdns } from "./e2e-kit.js";
import { ADVERTISE_RETRY_DELAYS_MS, type AdvertiseService } from "./mdns.js";

const ROUTES_DIR = fileURLToPath(new URL("./routes", import.meta.url));

const handles: DaemonHandle[] = [];
afterEach(async () => {
  while (handles.length) {
    const h = handles.pop();
    await h?.stop();
  }
});

async function start() {
  const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-server-")) });
  const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
  handles.push(handle);
  return handle;
}

/** 取一个当前空闲的本地端口（listen 0 后立即释放） */
function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const address = srv.address();
    const port = typeof address === "object" && address ? address.port : 0;
    srv.close(() => resolve(port));
  });
  return promise;
}

/** 手动时钟：逐次触发后台重试，断言退避序列而不用真等（不真发组播） */
function manualClock() {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  return {
    clock: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        timers.set(id, { fn, ms });
        delays.push(ms);
        return id;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    delays,
    pending: () => timers.size,
    /** 触发最早排定的重试并等其异步收尾（成功/失败排下一轮） */
    async fireNext(): Promise<void> {
      const next = timers.entries().next();
      if (next.done) throw new Error("no pending retry timer");
      const [id, timer] = next.value;
      timers.delete(id);
      timer.fn();
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    },
  };
}

function inbound(db: DaemonHandle["db"], subject: string) {
  const env = EnvelopeSchema.parse({
    v: 1,
    id: `msg_${ulid()}`,
    from: "alice@other-dev",
    to: "me@dev",
    subject,
    inReplyTo: null,
    references: [],
    createdAt: new Date().toISOString(),
    claim: { name: "alice", email: "alice@example.com" },
    seal: { alg: "x25519-aes256gcm", epk: "epk", iv: "iv", body: "sealed" },
    attachments: [],
    sig: "c2ln",
  } satisfies Record<string, unknown>) as Envelope;
  saveInbound(db, env, { body: `${subject}-正文`, attachments: [] }, { sigValid: true });
  return env;
}

function addPeer(db: DaemonHandle["db"]): { to: string; encPubPem: string } {
  const peerDirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-peer-")) });
  const peer = loadOrCreateIdentity(peerDirs);
  db.prepare(
    `INSERT INTO peers (device_id, device_name, user, device, claim_name, claim_email,
     sign_pub_pem, enc_pub_pem, paired_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    peer.deviceId,
    peer.deviceName,
    "bob",
    peer.deviceName,
    "bob",
    "bob@example.com",
    peer.signPubPem,
    peer.encPubPem,
    new Date().toISOString(),
  );
  return { to: `bob@${peer.deviceName}`, encPubPem: peer.encPubPem };
}

/** SSE 流：读取下一条 data 事件 */
async function openSse(base: string, signal: AbortSignal) {
  const res = await fetch(`${base}/v1/events`, { signal, headers: { accept: "text/event-stream" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next<T>(): Promise<{ type: string; data: T }> {
      for (;;) {
        const lineIdx = buffer.indexOf("\n\n");
        if (lineIdx >= 0) {
          const frame = buffer.slice(0, lineIdx);
          buffer = buffer.slice(lineIdx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) return JSON.parse(dataLine.slice(6)) as { type: string; data: T };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("sse closed");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      await reader.cancel();
    },
  };
}

describe("daemon start/stop", () => {
  it("随机端口可起可停：/alive 200 + AliveInfo 形状；stop 后连接拒绝", async () => {
    const handle = await start();
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/alive`);
    expect(res.status).toBe(200);
    const info = AliveInfoSchema.parse(await res.json());
    expect(info.fingerprint).toBe(handle.identity.deviceId);
    expect(info.pairedCount).toBe(0);

    await handle.stop();
    handles.pop();
    await expect(fetch(`http://127.0.0.1:${handle.port}/alive`)).rejects.toThrow();
  });

  it("pid 单例锁：被存活进程占用即 DaemonAlreadyRunningError（exitCode 3）", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-lock-")) });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    writeFileSync(join(dirs.dataDir, "daemon.pid"), `${child.pid}\n`);
    try {
      await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR });
      expect.unreachable("daemon should refuse to start");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
      expect((err as DaemonAlreadyRunningError).exitCode).toBe(3);
    } finally {
      child.kill();
    }
  });

  it("stop 执行优雅停机后可再次启动（pid 文件释放）", async () => {
    const handle = await start();
    const dirs = handle.dirs;
    await handle.stop();
    handles.pop();
    const again = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
    handles.push(again);
    expect((await fetch(`http://127.0.0.1:${again.port}/alive`)).status).toBe(200);
  });

  it("监听成功后按实际端口广播 mDNS（TXT 指纹=本机 deviceId），stop 撤销", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-wire-")) });
    const services: AdvertiseService[] = [];
    let ended = false;
    const handle = await startDaemon({
      port: 0,
      dirs,
      routesDir: ROUTES_DIR,
      mdns: {
        responder: {
          advertise: async (service) => {
            services.push(service);
            return { end: async () => void (ended = true) };
          },
          browse: async () => [],
        },
      },
    });
    handles.push(handle);

    expect(services).toHaveLength(1);
    expect(services[0]!.port).toBe(handle.port);
    expect(services[0]!.txt.fp).toBe(handle.identity.deviceId);
    expect(services[0]!.name).toBe(`amail-${handle.identity.deviceId}`);

    await handle.stop();
    handles.pop();
    expect(ended).toBe(true);
  });

  it("mDNS 探测失败不阻塞启动：广播超时仅告警降级，startDaemon 限时返回", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-slow-")) });
    const warnings: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const startedAt = Date.now();
    let handle: DaemonHandle | undefined;
    try {
      handle = await startDaemon({
        port: 0,
        dirs,
        routesDir: ROUTES_DIR,
        mdns: {
          // ciao 探测失败等同形态：advertise 永不 resolve
          responder: { advertise: () => Promise.withResolvers<never>().promise, browse: async () => [] },
          advertiseTimeoutMs: 30,
        },
      });
    } finally {
      errors.mockRestore();
    }

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(warnings.some((line) => line.includes("mDNS advertise failed"))).toBe(true);
    handles.push(handle!);
    expect((await fetch(`http://127.0.0.1:${handle!.port}/alive`)).status).toBe(200);
  });

  it("mDNS 首次失败后台重试：第 2 次成功即停，stop 撤销广播且无遗留定时器", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-retry-ok-")) });
    const { clock, delays, pending, fireNext } = manualClock();
    const services: AdvertiseService[] = [];
    let ended = 0;
    let attempts = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let handle: DaemonHandle;
    try {
      handle = await startDaemon({
        port: 0,
        dirs,
        routesDir: ROUTES_DIR,
        mdns: {
          responder: {
            advertise: async (service) => {
              services.push(service);
              attempts += 1;
              // ciao 探测冲突：首次失败后重试成功
              if (attempts === 1) throw new Error("probe conflict");
              return { end: async () => void (ended += 1) };
            },
            browse: async () => [],
          },
        },
        retry: { clock },
      });
    } finally {
      errorSpy.mockRestore();
    }
    handles.push(handle!);

    expect(services).toHaveLength(1);
    expect(delays).toEqual([ADVERTISE_RETRY_DELAYS_MS[0]]);
    expect(pending()).toBe(1);

    await fireNext();
    expect(services).toHaveLength(2);
    expect(services[1]!.port).toBe(handle!.port);
    expect(pending()).toBe(0); // 成功后不再排重试
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes("recovered"))).toBe(true);

    await handle!.stop();
    handles.pop();
    expect(ended).toBe(1);
    expect(pending()).toBe(0);
    warnSpy.mockRestore();
  });

  it("mDNS 持续失败：按 10s/30s/60s/120s/300s 退避封顶重试，期间服务正常", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-retry-all-")) });
    const { clock, delays, pending, fireNext } = manualClock();
    let attempts = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let handle: DaemonHandle;
    try {
      handle = await startDaemon({
        port: 0,
        dirs,
        routesDir: ROUTES_DIR,
        mdns: {
          responder: {
            advertise: async () => {
              attempts += 1;
              throw new Error("probe conflict");
            },
            browse: async () => [],
          },
        },
        retry: { clock },
      });
    } finally {
      errorSpy.mockRestore();
    }
    handles.push(handle!);

    expect(attempts).toBe(1);
    expect(delays).toEqual([ADVERTISE_RETRY_DELAYS_MS[0]]);
    for (let i = 0; i < 5; i += 1) await fireNext();

    expect(attempts).toBe(6);
    expect(delays).toEqual([10_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
    expect(pending()).toBe(1); // 仍在后台重试
    expect((await fetch(`http://127.0.0.1:${handle!.port}/alive`)).status).toBe(200);

    await handle!.stop();
    handles.pop();
    expect(pending()).toBe(0);
    debugSpy.mockRestore();
  });

  it("mDNS 降级重试中停机：待定重试被取消，不再触达响应器", async () => {
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-mdns-retry-stop-")) });
    const { clock, pending } = manualClock();
    let attempts = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let handle: DaemonHandle;
    try {
      handle = await startDaemon({
        port: 0,
        dirs,
        routesDir: ROUTES_DIR,
        mdns: {
          responder: {
            advertise: async () => {
              attempts += 1;
              throw new Error("probe conflict");
            },
            browse: async () => [],
          },
        },
        retry: { clock },
      });
    } finally {
      errorSpy.mockRestore();
    }
    handles.push(handle!);

    expect(attempts).toBe(1);
    expect(pending()).toBe(1);

    await handle!.stop();
    handles.pop();
    expect(pending()).toBe(0);
    expect(attempts).toBe(1);
  });

  it("端口越界（65536）：config 校验回退合法端口；显式 port 同步抛错也走清理（pid/DB）", async () => {
    const cfgDirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-badport-cfg-")) });
    writeFileSync(
      join(cfgDirs.configDir, "config.json"),
      JSON.stringify({ version: 1, name: "Alice", email: "a@example.com", port: 65536, notify: false }),
      "utf8",
    );
    const fallback = loadUserConfig(cfgDirs).port;
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBeLessThanOrEqual(65535);

    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-badport-")) });
    const err = await startDaemon({ port: 65536, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RangeError);
    expect(existsSync(join(dirs.dataDir, "daemon.pid"))).toBe(false);
    // DB 已关闭：可重新打开
    const db = openStore(dirs.storePath);
    db.close();
  });

  it("缺省端口读 config.port（--port 未给时）", async () => {
    const port = await freePort();
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-cfgport-")) });
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify({ version: 1, name: "Alice", email: "a@example.com", port, notify: false }),
      "utf8",
    );
    const handle = await startDaemon({ dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
    handles.push(handle);
    expect(handle.port).toBe(port);
  });

  it("监听失败（EADDRINUSE）reject 并清理 pid/DB，不报成功", async () => {
    const first = await start();
    const dirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), "amail-inuse-")) });
    const err = await startDaemon({
      port: first.port,
      dirs,
      routesDir: ROUTES_DIR,
      mdns: fakeMdns,
    }).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    expect(existsSync(join(dirs.dataDir, "daemon.pid"))).toBe(false);
    // DB 已关闭：可重新打开
    const db = openStore(dirs.storePath);
    db.close();
  });
});

describe("回环面隔离（伪造 remoteAddress）", () => {
  it("非 lan 路由：LAN 源 403；loopback 源（127/8、::1、v4-mapped）放行", async () => {
    const handle = await start();

    async function forged(remote: string | undefined, path = "/v1/inbox") {
      const chunks: Buffer[] = [];
      let status = 0;
      let ended: (() => void) | null = null;
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code;
          return this;
        },
        end(data?: unknown) {
          if (typeof data === "string" || Buffer.isBuffer(data)) {
            chunks.push(Buffer.from(data as string));
          }
          ended?.();
        },
        write() {
          return true;
        },
        on() {
          return this;
        },
      };
      const req = {
        method: "GET",
        url: path,
        socket: { remoteAddress: remote },
        on() {},
      };
      const { promise, resolve } = Promise.withResolvers<void>();
      ended = resolve;
      await handle.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      resolve();
      await promise;
      return { status, body: Buffer.concat(chunks).toString("utf8") };
    }

    for (const lan of ["192.168.1.9", "10.0.0.5", "::ffff:192.168.1.9", "fe80::1"]) {
      const r = await forged(lan);
      expect(r.status, lan).toBe(403);
      expect(JSON.parse(r.body).error).toBe("forbidden");
    }
    for (const lo of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", undefined]) {
      const r = await forged(lo);
      expect(r.status, String(lo)).toBe(200);
    }

    // SSE 端点同样只回环
    expect((await forged("192.168.1.9", "/v1/events")).status).toBe(403);
  });
});

describe("SSE 事件流", () => {
  it("send → outbox 事件；未配对 409", async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}`;
    const controller = new AbortController();
    const sse = await openSse(base, controller.signal);
    const { to } = addPeer(handle.db);

    const res = await fetch(`${base}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, subject: "sse", body: "b", refs: [] }),
    });
    expect(res.status).toBe(200);
    const { messageId } = (await res.json()) as { messageId: string };
    const event = await sse.next<{ messageId: string }>();
    expect(event.type).toBe("outbox");
    expect(event.data.messageId).toBe(messageId);
    await sse.close();
    controller.abort();

    const unpaired = await fetch(`${base}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "ghost@nowhere", subject: "s", body: "b", refs: [] }),
    });
    expect(unpaired.status).toBe(409);
    expect(((await unpaired.json()) as { error: string }).error).toBe("not-paired");
  });

  it("read → receipt 事件（仅首次）", async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}`;
    const env = inbound(handle.db, "sse-receipt");
    const controller = new AbortController();
    const sse = await openSse(base, controller.signal);

    const first = await fetch(`${base}/v1/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: env.id }),
    });
    expect(((await first.json()) as { read: boolean }).read).toBe(true);
    const event = await sse.next<{ messageId: string; kind: string }>();
    expect(event.type).toBe("receipt");
    expect(event.data).toEqual({ messageId: env.id, kind: "read" });

    const second = await fetch(`${base}/v1/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: env.id }),
    });
    expect(((await second.json()) as { read: boolean }).read).toBe(false);
    await sse.close();
    controller.abort();
  });
});

describe("inbox 读取（HTTP 面）", () => {
  it("GET /v1/inbox 列表条目形状", async () => {
    const handle = await start();
    const env = inbound(handle.db, "列表项");
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/inbox`);
    const items = (await res.json()) as Array<Record<string, unknown>>;
    expect(res.status).toBe(200);
    const item = items.find((i) => i.id === env.id)!;
    expect(item).toMatchObject({ from: "alice@other-dev", subject: "列表项", unread: true });
    expect(Object.keys(item).sort()).toEqual(
      ["from", "hasHandoff", "id", "receivedAt", "snippet", "subject", "unread"].sort(),
    );
  });
});

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { resolveDirs } from "../core/paths.js";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { saveInbound } from "../core/store.js";
import { AliveInfoSchema } from "../contract/api.js";
import { EnvelopeSchema, type Envelope } from "../contract/envelope.js";
import { DaemonAlreadyRunningError, startDaemon, type DaemonHandle } from "./server.js";
import { fakeMdns } from "./e2e-kit.js";
import type { AdvertiseService } from "./mdns.js";

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
        advertiseImpl: async (service) => {
          services.push(service);
          return { end: async () => void (ended = true) };
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

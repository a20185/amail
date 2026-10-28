import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../core/identity.js";
import { resolveDirs, type Dirs } from "../core/paths.js";
import { EventBus } from "./sse.js";
import type { AdvertiseHandle, MdnsDeps } from "./mdns.js";
import { advertise } from "./mdns.js";
import {
  defaultRoutesDir,
  isLoopbackAddress,
  loadRoutes,
  matchRoute,
  sendJson,
  type DaemonCore,
  type Disposer,
  type Route,
  type RouteCtx,
} from "./router.js";

export { isLoopbackAddress } from "./router.js";

const DEFAULT_PORT = 36969;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** 全局 setup 写的 config.json（Phase 3 创建；缺失时用兜底值） */
export interface UserConfig {
  name: string;
  email: string;
  /** 客户端与 daemon 共用的监听端口（缺省 36969） */
  port: number;
}

export function loadUserConfig(dirs: Dirs): UserConfig {
  const path = join(dirs.configDir, "config.json");
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UserConfig>;
    return {
      name: typeof raw.name === "string" && raw.name ? raw.name : "user",
      email: typeof raw.email === "string" && raw.email ? raw.email : "user@example.com",
      port:
        typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535
          ? raw.port
          : DEFAULT_PORT,
    };
  }
  return { name: "user", email: "user@example.com", port: DEFAULT_PORT };
}

/**
 * 地址用户名段归一（setup 展示与 daemon 实际地址共用同一规则）：
 * 小写 → 空格换连字符 → 仅保留 [a-z0-9-] → 空回退 user。
 */
export function normalizeUser(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[^a-z0-9-]+/g, "");
  return cleaned || "user";
}

function addressSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

/** 地址 = 人名@设备名（人名来自 config.json，规则与 setup 展示一致） */
export function userAddress(dirs: Dirs, identity: Pick<DeviceIdentityFull, "deviceName">): string {
  return `${normalizeUser(loadUserConfig(dirs).name)}@${addressSegment(identity.deviceName)}`;
}

/** 已有守护进程占用 pid 锁（进程退出码 3） */
export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`daemon already running (pid ${pid})`);
  }
  readonly exitCode = 3;
  readonly name = "DaemonAlreadyRunningError";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface SseClient {
  res: ServerResponse;
  unsubscribe: () => void;
}

export interface RequestHandlerArgs {
  core: DaemonCore;
  routes: Route[];
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      reject(new Error("body too large"));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) {
      resolve(undefined);
      return;
    }
    try {
      resolve(JSON.parse(text));
    } catch {
      reject(new Error("invalid JSON body"));
    }
  });
  req.on("error", reject);
  return promise;
}

function handleSse(core: DaemonCore, clients: Set<SseClient>, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  const unsubscribe = core.bus.on((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const client: SseClient = {
    res,
    unsubscribe: () => {
      unsubscribe();
      clients.delete(client);
    },
  };
  clients.add(client);
  req.on("close", () => {
    unsubscribe();
    clients.delete(client);
  });
}

/** HTTP 分发器（独立导出以便伪造 remoteAddress 测试回环面隔离） */
export function createHandler({ core, routes }: RequestHandlerArgs) {
  const sseClients = new Set<SseClient>();
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const remote = req.socket?.remoteAddress;

      // SSE 端点固定在 server 层（回环面）
      if (req.method === "GET" && url.pathname === "/v1/events") {
        if (!isLoopbackAddress(remote)) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        handleSse(core, sseClients, req, res);
        return;
      }

      const matched = matchRoute(routes, req.method ?? "GET", url.pathname);
      if (!matched) {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      // 回环面隔离：lan:false 路由仅规范化 loopback 源放行
      if (!matched.route.lan && !isLoopbackAddress(remote)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      let body: unknown;
      if (matched.route.method !== "GET" && !matched.route.raw) {
        body = await readBody(req);
      }
      const ctx: RouteCtx = {
        ...core,
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
      };
      await matched.route.handler(ctx);
    } catch (err) {
      sendJson(res, err instanceof SyntaxError || (err as Error).message === "invalid JSON body" ? 400 : 500, {
        error: (err as Error).message,
      });
    }
  };
  return { handler, sseClients };
}

export interface StartDaemonOptions {
  port?: number;
  dirs?: Dirs;
  /** 路由发现目录（测试注入 src/daemon/routes，不依赖构建产物） */
  routesDir?: string;
  /** mDNS 广播注入（测试用 fake；缺省真发组播） */
  mdns?: MdnsDeps;
}

export interface DaemonHandle extends DaemonCore {
  port: number;
  server: Server;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  address: string;
  stop(): Promise<void>;
}

/**
 * 启动守护进程：pid 单例锁 → openStore/identity/bus → 路由发现 + init disposer 收集
 * → 监听 ::（双栈，覆盖 0.0.0.0 与 ::，LAN 面可达）。
 * 回环隔离靠源地址判定，不靠监听地址。
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const dirs = options.dirs ?? resolveDirs();
  const port = options.port ?? loadUserConfig(dirs).port;

  const pidPath = join(dirs.dataDir, "daemon.pid");
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid !== process.pid && processAlive(pid)) {
      throw new DaemonAlreadyRunningError(pid);
    }
  }
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");

  const db = openStore(dirs.storePath);
  const identity = loadOrCreateIdentity(dirs);
  const core: DaemonCore = { db, dirs, identity, bus: new EventBus() };

  const { routes, inits } = await loadRoutes(options.routesDir ?? defaultRoutesDir());
  const disposers: Disposer[] = [];
  for (const init of inits) {
    const disposer = await init(core);
    if (typeof disposer === "function") disposers.push(disposer);
  }

  const { handler, sseClients } = createHandler({ core, routes });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  const { promise: listening, resolve: onListening, reject: onListenError } =
    Promise.withResolvers<void>();
  const onError = (err: Error) => onListenError(err);
  server.once("error", onError);
  try {
    // listen 同步抛（如端口越界 RangeError）同样走清理路径：pid/DB/后台任务不得残留
    server.listen(port, "::", () => onListening());
    await listening;
  } catch (err) {
    // 监听失败（如 EADDRINUSE）：清理已占用的资源后上抛，不得报成功
    for (const disposer of disposers.reverse()) {
      try {
        await disposer();
      } catch {
        // 清理尽力而为
      }
    }
    core.bus.closeAll();
    db.close();
    if (existsSync(pidPath)) rmSync(pidPath);
    throw err;
  } finally {
    server.removeListener("error", onError);
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  // mDNS 广播实际端口（发现不依赖固定口）；广播失败不阻断守护进程
  let advertisement: AdvertiseHandle | undefined;
  try {
    advertisement = await advertise(dirs, actualPort, options.mdns);
  } catch (err) {
    console.error(`[amail] mDNS advertise failed: ${(err as Error).message}`);
  }

  /**
   * 停机：广播撤销 → disposer → SSE/连接/监听关闭 → db/pid。
   * 注意 ciao 1.3.12 探测失败的重试定时器不可取消且无 unref，stop() 无法保证事件循环清空；
   * 进程终止由调用方（前台 daemon 的 SIGTERM/SIGINT 处理）显式 process.exit 兜底。
   */
  const stop = async (): Promise<void> => {
    try {
      await advertisement?.end();
    } catch {
      // 撤销广播失败不阻断停机
    }
    advertisement = undefined;
    for (const disposer of disposers.reverse()) {
      try {
        await disposer();
      } catch {
        // 单个 disposer 失败不阻断停机
      }
    }
    for (const client of sseClients) {
      client.unsubscribe();
      client.res.end();
    }
    core.bus.closeAll();
    server.closeAllConnections?.();
    const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
    server.close(() => onClosed());
    await closed;
    db.close();
    if (existsSync(pidPath)) rmSync(pidPath);
  };

  return { ...core, port: actualPort, server, handler, address: userAddress(dirs, identity), stop };
}

export const DAEMON_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

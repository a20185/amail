import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Dirs } from "../core/paths.js";
import type { DeviceIdentityFull } from "../core/identity.js";
import type { EventBus } from "./sse.js";

/** 路由可见的守护进程核心（init 与 handler 共用） */
export interface DaemonCore {
  db: DatabaseSync;
  dirs: Dirs;
  identity: DeviceIdentityFull;
  bus: EventBus;
}

/** 单条路由：path 支持 `:param` 段 */
export interface Route {
  method: "GET" | "POST";
  path: string;
  /** true = LAN 面可达；false = 仅规范化 loopback 源放行 */
  lan: boolean;
  handler: (ctx: RouteCtx) => void | Promise<void>;
}

export interface RouteCtx extends DaemonCore {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Disposer = () => void | Promise<void>;
export type RouteInit = (core: DaemonCore) => void | Disposer | Promise<void | Disposer>;

export interface LoadedRoutes {
  routes: Route[];
  inits: RouteInit[];
}

/** 路由发现基准：router 模块兄弟 routes/ 目录 */
export function defaultRoutesDir(): string {
  return fileURLToPath(new URL("./routes", import.meta.url));
}

/**
 * 路由发现：加载 dir（默认兄弟 routes/）下全部路由模块。
 * 模块契约：default export Route[]；可选 export init?(core) 返回 disposer。
 */
export async function loadRoutes(dir: string = defaultRoutesDir()): Promise<LoadedRoutes> {
  const entries = await readdir(dir);
  const files = entries
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !f.includes(".test."))
    .sort();
  const routes: Route[] = [];
  const inits: RouteInit[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as {
      default: Route[];
      init?: RouteInit;
    };
    if (!Array.isArray(mod.default)) {
      throw new Error(`route module ${file} must default-export Route[]`);
    }
    routes.push(...mod.default);
    if (typeof mod.init === "function") inits.push(mod.init);
  }
  return { routes, inits };
}

export interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
}

/** 方法 + 路径模式匹配（`:param` 捕获） */
export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): MatchedRoute | undefined {
  const segs = pathname.split("/").filter((s) => s.length > 0);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pat = route.path.split("/").filter((s) => s.length > 0);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i]!;
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(segs[i]!);
      } else if (p !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

/** 规范化源地址：v4-mapped `::ffff:a.b.c.d` → `a.b.c.d`，小写 */
export function normalizeRemoteAddress(remote: string | undefined): string {
  if (!remote) return "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(remote);
  return (mapped ? mapped[1] : remote).toLowerCase();
}

/**
 * 回环面判定：127.0.0.0/8、::1、v4-mapped loopback 均放行。
 * 无源地址（本地伪造/IPC）视为回环。
 */
export function isLoopbackAddress(remote: string | undefined): boolean {
  const addr = normalizeRemoteAddress(remote);
  if (addr === "") return true;
  if (addr === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return true;
  return false;
}

/** JSON 应答辅助 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

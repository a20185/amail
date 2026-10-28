import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dirs } from "../core/paths.js";

export const DEFAULT_PORT = 36969;

export interface UserConfigFile {
  version: number;
  name: string;
  email: string;
  port: number;
  notify: boolean;
}

export function readConfig(dirs: Dirs): UserConfigFile | undefined {
  const path = join(dirs.configDir, "config.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as UserConfigFile;
}

export function daemonPort(dirs: Dirs): number {
  return readConfig(dirs)?.port ?? DEFAULT_PORT;
}

export function daemonBase(dirs: Dirs): string {
  return `http://127.0.0.1:${daemonPort(dirs)}`;
}

/** 回环面 API 请求；非 2xx 抛带状态码与错误信息的错误 */
export async function apiFetch(
  dirs: Dirs,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${daemonBase(dirs)}${path}`, init);
  } catch (err) {
    throw new Error(
      `daemon unreachable at ${daemonBase(dirs)} — run \`amail daemon\` first (${(err as Error).message})`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = body.error ?? res.statusText;
    throw new Error(`daemon ${res.status}: ${String(detail)}`);
  }
  return body;
}

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  unread: boolean;
  receivedAt: string;
  hasHandoff: boolean;
}

/** CLI 动作公共上下文：测试注入沙箱 dirs 与 cwd */
export interface CmdCtx {
  dirs: Dirs;
  cwd: string;
}

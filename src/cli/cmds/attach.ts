/**
 * amail attach / detach —— 显式挂载本机会话镜像到工作区
 *
 * - amail attach [--cli cc|pi|opencode] [--cwd path] [--ws <workspaceId>] [--session <id>]
 *   工作区解析规则同 ws 命令（id 唯一；恰一个缺省直用；多个要求显式 --ws）。
 *   会话选择：--session 直选；唯一匹配直用；多个 → 列选择交互（非 TTY 报错并列出候选）。
 * - amail attach --list —— 列出本机可挂载会话
 * - amail detach <sessionId> [--ws <workspaceId>]
 */
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { amailSigHeaders } from "../../workspace/projection-local.js";
import { canonicalStringify } from "../../core/crypto.js";
import { daemonPort } from "../util.js";
import { openWsCtx, resolveWs, type WsCtx } from "./ws.js";
import type { SessionMeta } from "../../mirror/types.js";

export interface AttachOptions {
  cli?: string;
  cwd?: string;
  ws?: string;
  session?: string;
  list?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface AttachCtx extends WsCtx {
  base: string;
}

function openCtx(env?: NodeJS.ProcessEnv): AttachCtx {
  const ctx = openWsCtx(env);
  return { ...ctx, base: `http://127.0.0.1:${daemonPort(ctx.dirs)}` };
}

async function signedFetch(
  ctx: AttachCtx,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown } = { method: "GET" },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = init.method;
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...amailSigHeaders(ctx.identity.signPrivPem, method, pathname, bodyText, ctx.myAddr),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function cliLabel(cli: SessionMeta["cli"]): string {
  return { "claude-code": "cc", pi: "pi", opencode: "opencode" }[cli];
}

function fromCliLabel(label: string): SessionMeta["cli"] | undefined {
  return ({ cc: "claude-code", pi: "pi", opencode: "opencode" } as const)[label];
}

/** 列出本机可挂载会话（经回环 daemon，各适配器 discover 合并） */
export async function listAttachable(env?: NodeJS.ProcessEnv, ws?: string): Promise<SessionMeta[]> {
  const ctx = openCtx(env);
  const row = resolveWs(ctx, ws);
  const { status, json } = await signedFetch(ctx, `/ws/${row.id}/mirror/attachable`);
  if (status !== 200) throw new Error(`attachable ${status}: ${String(json.error ?? "")}`);
  return (json.sessions as SessionMeta[]) ?? [];
}

/** 候选过滤：--cli / --cwd / --session */
function filterSessions(sessions: SessionMeta[], options: AttachOptions): SessionMeta[] {
  return sessions.filter((s) => {
    if (options.session && s.sessionId !== options.session) return false;
    if (options.cli) {
      const cli = fromCliLabel(options.cli);
      if (!cli || s.cli !== cli) return false;
    }
    if (options.cwd && s.cwd !== options.cwd) return false;
    return true;
  });
}

async function pickSession(sessions: SessionMeta[], options: AttachOptions): Promise<SessionMeta> {
  const candidates = filterSessions(sessions, options);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    const hint = options.session
      ? `no attachable session ${options.session}`
      : "no attachable session matches the filters — run `amail attach --list`";
    throw new Error(hint);
  }
  if (options.session) return candidates.find((s) => s.sessionId === options.session)!;
  // 列选择交互（TTY）；非 TTY 报错并列出候选
  const listed = candidates
    .map((s, i) => `  ${i + 1}. ${s.sessionId}  [${cliLabel(s.cli)}]  ${s.cwd}${s.title ? ` — ${s.title}` : ""}`)
    .join("\n");
  if (!process.stdin.isTTY) {
    throw new Error(`multiple sessions — pass --session <id>:\n${listed}`);
  }
  console.log(listed);
  const { promise, resolve } = Promise.withResolvers<string>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("select session #> ", (answer) => {
    rl.close();
    resolve(answer);
  });
  const answer = await promise;
  const idx = Number.parseInt(answer, 10) - 1;
  const picked = candidates[idx];
  if (!picked) throw new Error(`invalid selection: ${answer}`);
  return picked;
}

export interface AttachOutcome {
  attachEventId: string;
  seq: number;
  session: SessionMeta;
}

export async function runAttach(options: AttachOptions): Promise<AttachOutcome> {
  const ctx = openCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const list = await signedFetch(ctx, `/ws/${row.id}/mirror/attachable`);
  if (list.status !== 200) throw new Error(`attachable ${list.status}: ${String(list.json.error ?? "")}`);
  const sessions = (list.json.sessions as SessionMeta[]) ?? [];
  const picked = await pickSession(sessions, options);

  const path = `/ws/${row.id}/mirror/attach`;
  const { status, json } = await signedFetch(ctx, path, {
    method: "POST",
    body: { sessionId: picked.sessionId, cli: picked.cli },
  });
  if (status !== 201) throw new Error(`attach ${status}: ${String(json.error ?? "")}`);
  const outcome = {
    attachEventId: String(json.attachEventId),
    seq: Number(json.seq),
    session: picked,
  };
  console.log(
    `attached ${picked.sessionId} [${cliLabel(picked.cli)}] (attach event seq=${outcome.seq})`,
  );
  return outcome;
}

export async function runDetach(sessionId: string, options: { ws?: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const ctx = openCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const { status, json } = await signedFetch(ctx, `/ws/${row.id}/mirror/${sessionId}`, { method: "DELETE" });
  if (status !== 200) throw new Error(`detach ${status}: ${String(json.error ?? "")}`);
  console.log(`detached ${sessionId}`);
}

export default function register(program: Command): void {
  program
    .command("attach")
    .description("attach a local CLI session mirror to a workspace")
    .option("--cli <cc|pi|opencode>", "filter by CLI")
    .option("--cwd <path>", "filter by working directory")
    .option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)")
    .option("--session <id>", "attach this session id directly")
    .option("--list", "list attachable local sessions")
    .action(async (options: AttachOptions) => {
      if (options.list) {
        const sessions = await listAttachable(options.env, options.ws);
        for (const s of sessions) {
          console.log(`${s.sessionId}  [${cliLabel(s.cli)}]  ${s.cwd}${s.title ? ` — ${s.title}` : ""}`);
        }
        return;
      }
      await runAttach(options);
    });

  program
    .command("detach <sessionId>")
    .description("detach a mirrored session from its workspace")
    .option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)")
    .action(async (sessionId: string, options: { ws?: string }) => {
      await runDetach(sessionId, options);
    });
}

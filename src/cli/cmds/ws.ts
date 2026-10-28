import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import type { DatabaseSync } from "node:sqlite";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../../core/identity.js";
import { canonicalStringify } from "../../core/crypto.js";
import { userAddress } from "../../daemon/server.js";
import { EventBus } from "../../daemon/sse.js";
import { projectBySlug } from "../../core/project.js";
import { get as getMessage } from "../../core/store.js";
import { apiFetch, daemonPort } from "../util.js";
import { createWorkspace, getWorkspaceRow, type WorkspaceRow } from "../../workspace/host.js";
import { makeEvent, newTodoId, type SubmitEvent, type WorkspaceState } from "../../workspace/events.js";
import { amailSigHeaders, localState, resolveHostBase } from "../../workspace/projection-local.js";
import { acceptInvite, parseInviteFromText, type WorkspaceInvite } from "../../workspace/invite.js";

export interface WsOptions {
  ws?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface WsCtx {
  dirs: Dirs;
  db: DatabaseSync;
  identity: DeviceIdentityFull;
  myAddr: string;
}

function openWsCtx(env?: NodeJS.ProcessEnv): WsCtx {
  const dirs = resolveDirs(env ?? process.env);
  const db = openStore(dirs.storePath);
  const identity = loadOrCreateIdentity(dirs);
  return { dirs, db, identity, myAddr: userAddress(dirs, identity) };
}

function listLocalWorkspaces(ctx: WsCtx): WorkspaceRow[] {
  return ctx.db.prepare("SELECT * FROM workspaces ORDER BY created_at").all() as unknown as WorkspaceRow[];
}

export interface WsOptions {
  ws?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function resolveWs(ctx: WsCtx, explicit?: string): WorkspaceRow {
  if (explicit) {
    const row = getWorkspaceRow(ctx.db, explicit);
    if (!row) throw new Error(`unknown workspace: ${explicit}`);
    return row;
  }
  const rows = listLocalWorkspaces(ctx);
  if (rows.length === 0) {
    throw new Error("no workspaces on this device — run `amail ws create` or `amail ws accept` first");
  }
  if (rows.length > 1) {
    const listed = rows.map((r) => `  ${r.id}  ${r.name} (host=${r.host_addr})`).join("\n");
    throw new Error(`multiple workspaces — pass --ws <workspaceId>:\n${listed}`);
  }
  return rows[0]!;
}


async function submitEvent(ctx: WsCtx, row: WorkspaceRow, event: SubmitEvent): Promise<{ seq: number }> {
  const pathname = `/ws/${row.id}/events`;
  const bodyText = canonicalStringify(event);
  const headers = {
    "content-type": "application/json",
    ...amailSigHeaders(ctx.identity.signPrivPem, "POST", pathname, bodyText, ctx.myAddr),
  };
  let base: string;
  if (row.host_addr === ctx.myAddr) {
    base = `http://127.0.0.1:${daemonPort(ctx.dirs)}`;
  } else {
    const resolved = await resolveHostBase(ctx.db, row.host_addr);
    if (!resolved) throw new Error(`host ${row.host_addr} unreachable — is the daemon running?`);
    base = resolved;
  }
  const res = await fetch(`${base}${pathname}`, { method: "POST", headers, body: bodyText });
  const out = (await res.json().catch(() => ({}))) as { seq?: number; error?: string };
  if (!res.ok) throw new Error(`submit ${res.status}: ${String(out.error ?? res.statusText)}`);
  return { seq: out.seq ?? 0 };
}

// ---------------------------------------------------------------------------
// create / list
// ---------------------------------------------------------------------------

export interface WsCreateOptions {
  project: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
}

/** ws create --project <slug> [--name]：建区单事务（workspaces 行 + 房主 membership add seq=1） */
export function runWsCreate(options: WsCreateOptions): string {
  const dirs = resolveDirs(options.env ?? process.env);
  const project = projectBySlug(dirs, options.project);
  if (!project) throw new Error(`unknown project: ${options.project} — run \`amail project add ${options.project}\` first`);
  const db = openStore(dirs.storePath);
  const identity = loadOrCreateIdentity(dirs);
  const bus = new EventBus();
  const id = createWorkspace({ db, dirs, identity, bus }, {
    name: options.name ?? project.name,
    projectSlug: options.project,
  });
  console.log(`workspace created: ${id}`);
  return id;
}

export function runWsList(env?: NodeJS.ProcessEnv): void {
  const ctx = openWsCtx(env);
  const rows = listLocalWorkspaces(ctx);
  if (rows.length === 0) {
    console.log("no workspaces — run `amail ws create` or `amail ws accept`");
    return;
  }
  for (const row of rows) {
    const role = row.host_addr === ctx.myAddr ? "host" : "member";
    console.log(`${row.id}\t${row.name}\t${role}\thost=${row.host_addr}`);
  }
}

// ---------------------------------------------------------------------------
// invite / accept
// ---------------------------------------------------------------------------

export async function runWsInvite(to: string, options: WsOptions): Promise<WorkspaceInvite> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  if (row.host_addr !== ctx.myAddr) throw new Error("only the host can invite — ask the host to run `amail ws invite`");
  const pathname = `/ws/${row.id}/invite`;
  const headers = {
    "content-type": "application/json",
    ...amailSigHeaders(ctx.identity.signPrivPem, "POST", pathname, "", ctx.myAddr),
  };
  const invite = (await apiFetch(ctx.dirs, pathname, { method: "POST", headers })) as WorkspaceInvite;
  // 邀请块随信件正文送达
  await apiFetch(ctx.dirs, "/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      to,
      subject: `workspace invite: ${row.name}`,
      body: JSON.stringify(invite, null, 2),
      refs: [],
    }),
  });
  console.log(`invite sent to ${to} (workspace ${row.id})`);
  return invite;
}

export interface WsAcceptOptions {
  file?: string;
  mail?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runWsAccept(options: WsAcceptOptions): Promise<void> {
  const dirs = resolveDirs(options.env ?? process.env);
  let text: string;
  if (options.file) {
    text = readFileSync(options.file, "utf8");
  } else if (options.mail) {
    const db = openStore(dirs.storePath);
    const msg = getMessage(db, options.mail);
    if (!msg) throw new Error(`unknown message: ${options.mail}`);
    text = msg.body;
  } else {
    throw new Error("pass --file <invite.json> or --mail <msgId>");
  }
  const invite = parseInviteFromText(text);
  const result = await acceptInvite(dirs, invite);
  console.log(`joined workspace ${result.workspaceId}${result.alreadyMember ? " (already a member)" : ""}`);
}

// ---------------------------------------------------------------------------
// state / export
// ---------------------------------------------------------------------------

export type WsStateKind = "actions" | "todos" | "artifacts" | "members";

export interface WsStateOptions extends WsOptions {
  kind?: WsStateKind;
}

/** CLI 的 state 一律经回环路由触发 daemon 同步后读本地缓存投影（离线退化为只读缓存） */
export async function runWsState(options: WsStateOptions): Promise<WorkspaceState> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  if (row.host_addr !== ctx.myAddr) {
    await apiFetch(ctx.dirs, `/v1/ws-sync/${row.id}`, { method: "POST" }).catch(() => {});
  }
  const state = localState(ctx.db, row.id);
  const pick = options.kind ?? "actions";
  const items: unknown[] =
    pick === "actions" ? state.actions : pick === "todos" ? state.todos : pick === "artifacts" ? state.artifacts : state.members;
  for (const item of items) console.log(typeof item === "string" ? item : JSON.stringify(item));
  return state;
}

export interface WsExportOptions extends WsOptions {
  out?: string;
}

function renderActions(state: WorkspaceState): string {
  const lines = ["# Actions", ""];
  for (const a of state.actions) {
    lines.push(`- [seq ${a.seq}] ${a.payload.who}: ${a.payload.content}${a.payload.note ? ` — ${a.payload.note}` : ""}`);
  }
  if (state.actions.length === 0) lines.push("(none)");
  return lines.join("\n") + "\n";
}

function renderTodos(state: WorkspaceState): string {
  const lines = ["# Backlog", ""];
  const order = { todo: 0, doing: 1, done: 2, dropped: 3 } as const;
  const sorted = [...state.todos].sort((x, y) => x.priority - y.priority || order[x.status] - order[y.status]);
  for (const t of sorted) {
    const due = t.dueRange ? ` (due ${t.dueRange.from}→${t.dueRange.to})` : "";
    lines.push(`- [${t.status}] P${t.priority} ${t.title}${due} — ${t.id}`);
  }
  if (sorted.length === 0) lines.push("(none)");
  return lines.join("\n") + "\n";
}

function renderArtifacts(state: WorkspaceState): string {
  const lines = ["# Artifacts", ""];
  for (const a of state.artifacts) {
    lines.push(`- ${a.payload.name} (${a.payload.mime}, ${a.payload.size}B) — ${a.payload.artifactId}`);
  }
  if (state.artifacts.length === 0) lines.push("(none)");
  return lines.join("\n") + "\n";
}

/** ws export [--out dir]：投影导出三 markdown（Actions/Backlog/Artifacts） */
export async function runWsExport(options: WsExportOptions): Promise<string[]> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const state = localState(ctx.db, row.id);
  const outDir = options.out ?? (options.cwd ?? process.cwd());
  mkdirSync(outDir, { recursive: true });
  const files: Array<[string, string]> = [
    ["Actions.md", renderActions(state)],
    ["Backlog.md", renderTodos(state)],
    ["Artifacts.md", renderArtifacts(state)],
  ];
  const paths: string[] = [];
  for (const [name, content] of files) {
    const p = join(outDir, name);
    writeFileSync(p, content, "utf8");
    paths.push(p);
    console.log(p);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// action / todo
// ---------------------------------------------------------------------------

export interface WsActionOptions extends WsOptions {
  who: string;
  content: string;
  note?: string;
  cc: string[];
}

export async function runWsAction(options: WsActionOptions): Promise<{ seq: number }> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const event = makeEvent(ctx.identity.signPrivPem, ctx.myAddr, "action", {
    who: options.who,
    content: options.content,
    note: options.note,
    cc: options.cc,
  });
  const result = await submitEvent(ctx, row, event);
  console.log(`action recorded (seq ${result.seq})`);
  return result;
}

export interface WsTodoAddOptions extends WsOptions {
  priority: number;
  due?: { from: string; to: string };
}

export async function runWsTodoAdd(title: string, options: WsTodoAddOptions): Promise<{ seq: number }> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const event = makeEvent(ctx.identity.signPrivPem, ctx.myAddr, "todo", {
    id: newTodoId(),
    title,
    priority: options.priority as 0 | 1 | 2 | 3,
    dueRange: options.due,
    status: "todo",
  });
  const result = await submitEvent(ctx, row, event);
  console.log(`todo added (seq ${result.seq})`);
  return result;
}

export interface WsTodoSetOptions extends WsOptions {
  status?: "todo" | "doing" | "done" | "dropped";
  priority?: number;
  due?: { from: string; to: string };
}

export async function runWsTodoSet(id: string, options: WsTodoSetOptions): Promise<{ seq: number }> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const state = localState(ctx.db, row.id);
  const current = state.todos.find((t) => t.id === id);
  if (!current) throw new Error(`unknown todo: ${id}`);
  const event = makeEvent(ctx.identity.signPrivPem, ctx.myAddr, "todo", {
    id,
    title: current.title,
    priority: (options.priority ?? current.priority) as 0 | 1 | 2 | 3,
    dueRange: options.due ?? current.dueRange,
    status: options.status ?? current.status,
  });
  const result = await submitEvent(ctx, row, event);
  console.log(`todo updated (seq ${result.seq})`);
  return result;
}

// ---------------------------------------------------------------------------
// commander 注册
// ---------------------------------------------------------------------------

function wsOption(cmd: Command): Command {
  return cmd.option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)");
}

export default function register(program: Command): void {
  const ws = program.command("ws").description("shared workspaces (host-authoritative event log)");

  wsOption(ws.command("create"))
    .description("create a workspace (host membership add seq=1 in one transaction)")
    .requiredOption("--project <slug>", "source project slug (registered via `amail project add`)")
    .option("--name <name>", "display name (defaults to project name)")
    .action(async (opts: { project: string; name?: string }) => {
      runWsCreate({ project: opts.project, name: opts.name });
    });

  ws.command("list").description("list local workspaces and roles").action(() => runWsList());

  wsOption(ws.command("invite"))
    .description("generate an invite block and mail it to a paired peer")
    .argument("<to>", "invitee address user@device")
    .action(async (to: string, opts: { ws?: string }) => {
      await runWsInvite(to, { ws: opts.ws });
    });

  ws.command("accept")
    .description("accept a workspace invite from a file or a mail message")
    .option("--file <path>", "invite JSON file")
    .option("--mail <msgId>", "message id containing the invite")
    .action(async (opts: { file?: string; mail?: string }) => {
      await runWsAccept({ file: opts.file, mail: opts.mail });
    });

  wsOption(ws.command("state"))
    .description("read the local projection (triggers daemon sync for member workspaces)")
    .option("--kind <kind>", "actions | todos | artifacts | members")
    .action(async (opts: { ws?: string; kind?: WsStateKind }) => {
      await runWsState({ ws: opts.ws, kind: opts.kind });
    });

  wsOption(ws.command("export"))
    .description("export projection markdown (Actions.md / Backlog.md / Artifacts.md)")
    .option("--out <dir>", "output directory (defaults to cwd)")
    .action(async (opts: { ws?: string; out?: string }) => {
      await runWsExport({ ws: opts.ws, out: opts.out });
    });

  wsOption(ws.command("action"))
    .description("record an action event")
    .requiredOption("--who <addr>", "who performed the action")
    .requiredOption("--content <content>", "action content")
    .option("--note <note>", "optional note")
    .option("--cc <addr>", "cc notification target (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .action(async (opts: { ws?: string; who: string; content: string; note?: string; cc: string[] }) => {
      await runWsAction({ ws: opts.ws, who: opts.who, content: opts.content, note: opts.note, cc: opts.cc });
    });

  const todo = ws.command("todo").description("todo events");

  wsOption(todo.command("add"))
    .description("add a todo (title as positional argument)")
    .argument("<title>", "todo title")
    .option("--priority <n>", "0..3 (default 2)", (v: string) => Number.parseInt(v, 10), 2)
    .option("--due <from,to>", "due range 'from,to'")
    .action(async (title: string, opts: { ws?: string; priority: number; due?: string }) => {
      const due = (() => {
        if (!opts.due) return undefined;
        const [from, to] = opts.due.split(",");
        if (!from || !to) throw new Error("--due expects from,to");
        return { from, to };
      })();
      await runWsTodoAdd(title, { ws: opts.ws, priority: opts.priority, due });
    });

  wsOption(todo.command("set"))
    .description("update a todo")
    .argument("<id>", "todo id (td_…)")
    .option("--status <status>", "todo | doing | done | dropped")
    .option("--priority <n>", "0..3", (v: string) => Number.parseInt(v, 10))
    .option("--due <from,to>", "due range 'from,to'")
    .action(async (id: string, opts: { ws?: string; status?: WsTodoSetOptions["status"]; priority?: number; due?: string }) => {
      const due = (() => {
        if (!opts.due) return undefined;
        const [from, to] = opts.due.split(",");
        if (!from || !to) throw new Error("--due expects from,to");
        return { from, to };
      })();
      await runWsTodoSet(id, { ws: opts.ws, status: opts.status, priority: opts.priority, due });
    });
}

/**
 * claude-code 适配器
 *
 * 会话根：~/.claude/projects/<slug>/<sessionId>.jsonl（slug = cwd 绝对路径中 `/`→`-`，
 * 验证：/Users/souler/Test → -Users-souler-Test；cwd 优先取 jsonl 行内 cwd 字段，缺省回退 unslug）。
 * stream = 增量尾随：fs.watch 目标文件所在目录 + 记字节偏移增量读；watch 静默/ENOENT 时
 * 500ms 轮询兜底；新增一行即产事件。hooks 不装（避免改用户 settings.json）；未来可作
 * 可选加速器，MirrorEvent 接口不变。
 *
 * 行 → RawMirrorEvent 映射：
 * - message.content[].type === "text" → { role: message.role, text }
 * - tool_use Edit       → { path: file_path, before: old_string, after: new_string }
 * - tool_use Write      → { path: file_path, after: content }（无 before）
 * - tool_use NotebookEdit → { path: notebook_path, after: new_source }（无 before）
 * - 其余（thinking/tool_result/queue-operation 等）忽略
 */
import { watch, openSync, readSync, closeSync, statSync, readdirSync, existsSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { RawMirrorEvent } from "../contract/api.js";
import type { MirrorAdapter, SessionMeta } from "./types.js";

/** cwd 绝对路径 → project 目录 slug */
export function ccSlug(cwd: string): string {
  return resolve(cwd).replaceAll("/", "-");
}
/** slug → cwd（best-effort 逆映射：首 `-`→`/`，其余 `-`→`/`） */
export function ccUnslug(slug: string): string {
  const body = slug.replace(/^-/, "");
  return "/" + body.replaceAll("-", "/");
}

/** 增量尾随 jsonl：先吐存量完整行，随后 watch + 500ms 轮询兜底产出新行 */
export async function* tailJsonl(
  file: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  let offset = 0;
  let partial = "";
  const pending: string[] = [];
  let waiters: Array<() => void> = [];
  let stopped = false;
  const wake = () => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };

  const check = () => {
    try {
      const size = statSync(file).size;
      if (size < offset) {
        offset = 0; // 截断重建
        partial = "";
      }
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      const fd = openSync(file, "r");
      try {
        readSync(fd, buf, 0, buf.length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      partial += buf.toString("utf8");
      let idx: number;
      while ((idx = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, idx);
        partial = partial.slice(idx + 1);
        if (line.trim()) pending.push(line);
      }
      if (pending.length) wake();
    } catch {
      // ENOENT：文件尚未创建/已删除，等轮询兜底
    }
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(file), (event, filename) => {
      if (!filename || filename === basename(file)) check();
    });
    watcher.on("error", () => {});
  } catch {
    // 目录不存在 → 只靠轮询
  }
  const poll = setInterval(check, 500);
  const onAbort = () => {
    stopped = true;
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    check();
    for (;;) {
      if (stopped) return;
      while (pending.length > 0) {
        const line = pending.shift()!;
        if (stopped) return;
        yield line;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push(resolve);
      await promise;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    clearInterval(poll);
    watcher?.close();
  }
}

/** claude-code jsonl 行 → RawMirrorEvent 列表 */
export function claudeLineEvents(sessionId: string, lineText: string): RawMirrorEvent[] {
  let line: Record<string, unknown>;
  try {
    line = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    return [];
  }
  const message = line.message as { role?: string; content?: unknown[] } | undefined;
  if (!message || !Array.isArray(message.content)) return [];
  const t = typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();
  const out: RawMirrorEvent[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ t, sessionId, role: message.role ?? "assistant", text: b.text });
      continue;
    }
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    const path = [input.file_path, input.notebook_path].find((v) => typeof v === "string") as
      | string
      | undefined;
    if (b.name === "Edit" && typeof input.old_string === "string") {
      out.push({ t, sessionId, path, before: input.old_string, after: input.new_string as string });
    } else if (b.name === "Write" && typeof input.content === "string") {
      out.push({ t, sessionId, path, after: input.content });
    } else if (b.name === "NotebookEdit" && typeof input.new_source === "string") {
      out.push({ t, sessionId, path, after: input.new_source });
    }
  }
  return out;
}

/** 从 jsonl 头部行提取 cwd / 首个 timestamp / 首个用户文本（title 线索） */
function scanHead(file: string): { cwd?: string; startedAt?: string; title?: string } {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(statSync(file).size, 64 * 1024));
      readSync(fd, buf, 0, buf.length, 0);
      let startedAt: string | undefined;
      let cwd: string | undefined;
      let title: string | undefined;
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!startedAt && typeof o.timestamp === "string") startedAt = o.timestamp;
        if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
        const m = o.message as { role?: string; content?: unknown[] } | undefined;
        if (!title && m?.role === "user" && Array.isArray(m.content)) {
          const textBlock = m.content.find(
            (c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text",
          ) as Record<string, unknown> | undefined;
          const text = textBlock?.text;
          if (typeof text === "string" && text.trim()) title = text.split("\n")[0]!.slice(0, 80);
        }
        if (startedAt && cwd && title) break;
      }
      return { cwd, startedAt, title };
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
}

export function claudeCodeAdapter(root: string = join(homedir(), ".claude")): MirrorAdapter {
  const projectsDir = join(root, "projects");

  function sessionFile(sessionId: string): string | undefined {
    if (!existsSync(projectsDir)) return undefined;
    for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(projectsDir, dir.name, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
    return undefined;
  }

  return {
    id: "claude-code",
    discover(cwd?: string): SessionMeta[] {
      if (!existsSync(projectsDir)) return [];
      const dirs = cwd
        ? [ccSlug(cwd)]
        : readdirSync(projectsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
      const out: SessionMeta[] = [];
      for (const slug of dirs) {
        const dir = join(projectsDir, slug);
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const file = join(dir, entry.name);
          const stat = statSync(file);
          const head = scanHead(file);
          out.push({
            sessionId: entry.name.replace(/\.jsonl$/, ""),
            cli: "claude-code",
            cwd: head.cwd ?? ccUnslug(slug),
            title: head.title,
            startedAt: head.startedAt ?? stat.mtime.toISOString(),
            mtime: stat.mtime.toISOString(),
          });
        }
      }
      return out;
    },
    async *stream(sessionId, signal) {
      const file = sessionFile(sessionId);
      if (!file) throw new Error(`claude-code session not found: ${sessionId}`);
      for await (const line of tailJsonl(file, signal)) {
        yield* claudeLineEvents(sessionId, line);
      }
    },
  };
}

/**
 * pi 适配器
 *
 * 会话根：~/.pi/agent/sessions/<slug>/<时间戳>_<uuid>.jsonl（sessionId = 文件名尾段 uuid；
 * cwd 取首行 type=session 条目的 cwd 字段，缺省回退目录名 unslug——pi 的 slug 同样是
 * 路径 `/`→`-`）。增量尾随与 500ms 轮询兜底同 claude-code（复用 tailJsonl）。
 *
 * 行 → RawMirrorEvent 映射（以 tests/fixtures/mirror/pi 真实 fixture 实测字段为准）：
 * - type="session" / "model_change" / "thinking_level_change" → 忽略（元数据行）
 * - type="message"，message.content[]：
 *   - item.type="text" → { role: message.role, text }
 *   - item.type="tool_call"（fixture 未出现；按 pi 事件 schema 预留）：
 *     tool 名含 edit → { path: args.filePath, before: args.oldString, after: args.newString }；
 *     名含 write → { path: args.filePath, after: args.content }；其余忽略
 *   - item.type="thinking"/其他 → 忽略
 * - t 取行内 timestamp
 */
import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { RawMirrorEvent } from "../contract/api.js";
import type { MirrorAdapter, SessionMeta } from "./types.js";
import { tailJsonl, ccUnslug } from "./claude-code.js";

function piLineEvents(sessionId: string, lineText: string): RawMirrorEvent[] {
  let line: Record<string, unknown>;
  try {
    line = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (line.type !== "message") return [];
  const message = line.message as { role?: string; content?: unknown[] } | undefined;
  if (!message || !Array.isArray(message.content)) return [];
  const t = typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();
  const out: RawMirrorEvent[] = [];
  for (const item of message.content) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ t, sessionId, role: message.role ?? "assistant", text: b.text });
      continue;
    }
    if (b.type === "tool_call" && typeof b.tool === "string") {
      const args = (b.arguments ?? b.args ?? {}) as Record<string, unknown>;
      const path = typeof args.filePath === "string" ? args.filePath : undefined;
      const tool = b.tool.toLowerCase();
      if (tool.includes("edit") && typeof args.oldString === "string") {
        out.push({ t, sessionId, path, before: args.oldString, after: args.newString as string });
      } else if (tool.includes("write") && typeof args.content === "string") {
        out.push({ t, sessionId, path, after: args.content });
      }
    }
  }
  return out;
}

/** 首行即 session 元数据行（type=session，含 cwd/timestamp） */
function readFirstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, n);
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  } finally {
    closeSync(fd);
  }
}

function headInfo(file: string): { cwd?: string; startedAt?: string } {
  try {
    const first = JSON.parse(readFirstLine(file)) as Record<string, unknown>;
    return {
      cwd: typeof first.cwd === "string" ? first.cwd : undefined,
      startedAt: typeof first.timestamp === "string" ? first.timestamp : undefined,
    };
  } catch {
    return {};
  }
}

export function piAdapter(root: string = join(homedir(), ".pi/agent/sessions")): MirrorAdapter {
  interface Found {
    file: string;
    slug: string;
  }
  function listFiles(): Found[] {
    if (!existsSync(root)) return [];
    const out: Found[] = [];
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const entry of readdirSync(join(root, dir.name), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          out.push({ file: join(root, dir.name, entry.name), slug: dir.name });
        }
      }
    }
    return out;
  }

  return {
    id: "pi",
    discover(cwd?: string): SessionMeta[] {
      return listFiles()
        .filter((f) => !cwd || f.slug === cwd.replaceAll("/", "-"))
        .map(({ file, slug }) => {
          const stat = statSync(file);
          const head = headInfo(file);
          return {
            sessionId: basename(file).replace(/\.jsonl$/, "").split("_").pop()!,
            cli: "pi" as const,
            cwd: head.cwd ?? ccUnslug(slug),
            startedAt: head.startedAt ?? stat.mtime.toISOString(),
            mtime: stat.mtime.toISOString(),
          };
        });
    },
    async *stream(sessionId, signal) {
      const found = listFiles().find(({ file }) => basename(file).endsWith(`_${sessionId}.jsonl`));
      if (!found) throw new Error(`pi session not found: ${sessionId}`);
      for await (const line of tailJsonl(found.file, signal)) {
        yield* piLineEvents(sessionId, line);
      }
    },
  };
}

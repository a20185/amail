/**
 * opencode 适配器（只读直读本地 opencode.db，WAL 只读模式——已裁定偏差五：
 * 直读本地 db 而非 service API，理由=无服务依赖、可 fixture 测试）
 *
 * 会话根：~/.local/share/opencode（db = <root>/opencode.db）。fixture-first：
 * tests/fixtures/mirror/opencode/opencode.db 由本机真实 db 拷贝脱敏而来（同 schema+少量行）。
 *
 * 表映射（实际表结构实测，写于此）：
 * - session(id, project_id, directory, title, time_created, time_updated, time_archived, ...)
 *   → SessionMeta：sessionId=id、cwd=directory、title=title、startedAt=time_created(ms→ISO)、
 *   mtime=time_updated；time_archived 非空的不列出
 * - message(id, session_id, time_created, data)：data.role 为消息角色（仅取角色，正文在 part）
 * - part(id, message_id, session_id, time_created, data)：data.type 取值
 *   text / reasoning / tool / step-start / step-finish / patch / compaction（实测计数）。
 *   → RawMirrorEvent 映射：
 *   - part.type="text"          → { role: 所属 message 的 role, text }
 *   - part.type="tool"，tool="edit"  → { path: state.input.filePath, before: oldString, after: newString }
 *   - part.type="tool"，tool="write" → { path: state.input.filePath, after: content }（无 before）
 *   - reasoning / step-start / step-finish / patch（无 diff 内容，仅 hash+files）/ compaction → 忽略
 * - stream = 按 (time_created, id) 增量轮询 part 表（500ms，与 jsonl 尾随同一兜底节奏）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { RawMirrorEvent } from "../contract/api.js";
import type { MirrorAdapter, SessionMeta } from "./types.js";

interface PartRow {
  id: string;
  time_created: number;
  data: string;
  role: string | null;
}

function mapPart(row: PartRow, sessionId: string): RawMirrorEvent | undefined {
  let part: Record<string, unknown>;
  try {
    part = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const t = new Date(row.time_created).toISOString();
  if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
    return { t, sessionId, role: row.role ?? "assistant", text: part.text };
  }
  if (part.type === "tool" && typeof part.tool === "string") {
    const state = (part.state ?? {}) as Record<string, unknown>;
    const input = (state.input ?? {}) as Record<string, unknown>;
    const path = typeof input.filePath === "string" ? input.filePath : undefined;
    if (part.tool === "edit" && typeof input.oldString === "string") {
      return { t, sessionId, path, before: input.oldString, after: input.newString as string };
    }
    if (part.tool === "write" && typeof input.content === "string") {
      return { t, sessionId, path, after: input.content };
    }
  }
  return undefined;
}

export function opencodeAdapter(root: string = join(homedir(), ".local/share/opencode")): MirrorAdapter {
  const dbPath = join(root, "opencode.db");
  let db: DatabaseSync | undefined;

  function open(): DatabaseSync | undefined {
    if (db) return db;
    if (!existsSync(dbPath)) return undefined;
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  }

  return {
    id: "opencode",
    discover(): SessionMeta[] {
      const handle = open();
      if (!handle) return [];
      try {
        const rows = handle
          .prepare(
            `SELECT id, directory, title, time_created, time_updated FROM session
             WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 200`,
          )
          .all() as unknown as Array<{
          id: string;
          directory: string;
          title: string;
          time_created: number;
          time_updated: number;
        }>;
        return rows.map((r) => ({
          sessionId: r.id,
          cli: "opencode" as const,
          cwd: r.directory,
          title: r.title || undefined,
          startedAt: new Date(r.time_created).toISOString(),
          mtime: new Date(r.time_updated).toISOString(),
        }));
      } catch {
        return [];
      }
    },
    async *stream(sessionId, signal) {
      const handle = open();
      if (!handle) throw new Error(`opencode session db not found: ${dbPath}`);
      // 复合游标 (time_created, id)：同一毫秒内多条 part 不丢失
      let cursorTime = -1;
      let cursorId = "";
      let stopped = false;
      const pending: RawMirrorEvent[] = [];
      let waiters: Array<() => void> = [];
      const wake = () => {
        const ws = waiters;
        waiters = [];
        for (const w of ws) w();
      };
      const onAbort = () => {
        stopped = true;
        wake();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const poll = () => {
        try {
          const rows = handle
            .prepare(
              `SELECT p.id AS id, p.time_created AS time_created, p.data AS data,
                      json_extract(m.data, '$.role') AS role
               FROM part p JOIN message m ON m.id = p.message_id
               WHERE p.session_id = ?
                 AND (p.time_created > ? OR (p.time_created = ? AND p.id > ?))
               ORDER BY p.time_created, p.id`,
            )
            .all(sessionId, cursorTime, cursorTime, cursorId) as unknown as PartRow[];
          for (const row of rows) {
            cursorTime = row.time_created;
            cursorId = row.id;
            const ev = mapPart(row, sessionId);
            if (ev) pending.push(ev);
          }
          if (pending.length) wake();
        } catch {
          // 读失败（并发写锁等）→ 下轮再试
        }
      };

      const timer = setInterval(poll, 500);
      try {
        poll();
        for (;;) {
          if (stopped) return;
          while (pending.length > 0) {
            const ev = pending.shift()!;
            if (stopped) return;
            yield ev;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          waiters.push(resolve);
          await promise;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        clearInterval(timer);
      }
    },
  };
}

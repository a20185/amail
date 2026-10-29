import { z } from "zod";
import type { Route } from "../router.js";
import { sendJson } from "../router.js";
import { exportArchive, projectBySlug } from "../../core/project.js";
import { get, listInbox, markArchived, markRead, search, type MessageRow } from "../../core/store.js";

import type { DatabaseSync } from "node:sqlite";
/** 收件箱列表条目 */
function toItem(row: MessageRow) {
  return {
    id: row.id,
    from: row.from_addr,
    subject: row.subject,
    snippet: row.body.slice(0, 120),
    unread: row.read_at === null,
    receivedAt: row.received_at ?? row.created_at,
    hasHandoff: row.handoff_json !== null,
  };
}

/**
 * 默认视图 = 未归档收件箱 + project 对应已归档件合并（daemon 层做合并）。
 * `all` 全量；显式 project 只看该项目（含归档）。
 */
function list(db: DatabaseSync, query: { project?: string; unread?: boolean; all?: boolean }): MessageRow[] {
  if (query.all) return listInbox(db, query);
  if (query.project) {
    const unarchived = listInbox(db, { unread: query.unread });
    const archived = listInbox(db, { all: true, project: query.project, unread: query.unread });
    const seen = new Set(archived.map((r) => r.id));
    return [...unarchived.filter((r) => !seen.has(r.id)), ...archived].sort((a, b) =>
      a.created_at < b.created_at ? 1 : -1,
    );
  }
  return listInbox(db, { unread: query.unread });
}

interface AttachmentRow {
  id: string;
  blob_path: string;
  name: string;
  mime: string | null;
  size: number;
  sha256: string;
}

const ReadReq = z.object({ id: z.string().min(1) });
const ArchiveReq = z.object({ id: z.string().min(1), project: z.string().min(1) });

const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/inbox",
    lan: false,
    handler({ res, db, query }) {
      const rows = list(db, {
        project: query.get("project") ?? undefined,
        unread: query.get("unread") === "true" ? true : undefined,
        all: query.get("all") === "true" ? true : undefined,
      });
      sendJson(res, 200, rows.map(toItem));
    },
  },
  {
    method: "GET",
    path: "/v1/message/:id",
    lan: false,
    handler({ res, db, params }) {
      const row = get(db, params.id!);
      if (!row) {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      const attachments = db
        .prepare(
          "SELECT id, blob_path, name, mime, size, sha256 FROM attachments WHERE message_id = ?",
        )
        .all(row.id) as unknown as AttachmentRow[];
      sendJson(res, 200, {
        id: row.id,
        direction: row.direction,
        from: row.from_addr,
        to: row.to_addr,
        subject: row.subject,
        inReplyTo: row.in_reply_to,
        threadRoot: row.thread_root,
        createdAt: row.created_at,
        receivedAt: row.received_at,
        readAt: row.read_at,
        archivedAt: row.archived_at,
        project: row.project,
        body: row.body,
        handoff: row.handoff_json ? (JSON.parse(row.handoff_json) as unknown) : null,
        attachments,
      });
    },
  },
  {
    // markRead 仅在 空→已读 转移时 emit receipt（首次读动作触发回执；重复 read 不重发）
    method: "POST",
    path: "/v1/read",
    lan: false,
    handler({ res, db, bus, body }) {
      const parsed = ReadReq.parse(body ?? {});
      const row = get(db, parsed.id);
      if (!row) {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      const changed = markRead(db, parsed.id);
      if (changed) {
        bus.emit("receipt", { messageId: parsed.id, kind: "read" });
      }
      sendJson(res, 200, { id: parsed.id, read: changed });
    },
  },
  {
    method: "POST",
    path: "/v1/archive",
    lan: false,
    handler({ res, db, dirs, body }) {
      const parsed = ArchiveReq.parse(body ?? {});
      if (!get(db, parsed.id)) {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      if (!projectBySlug(dirs, parsed.project)) {
        sendJson(res, 404, { error: "unknown-project", project: parsed.project });
        return;
      }
      const mdPath = exportArchive(dirs, db, parsed.id, parsed.project);
      markArchived(db, parsed.id, parsed.project);
      sendJson(res, 200, { id: parsed.id, project: parsed.project, path: mdPath });
    },
  },
  {
    method: "GET",
    path: "/v1/search",
    lan: false,
    handler({ res, db, query }) {
      const q = query.get("q") ?? "";
      sendJson(res, 200, search(db, q).map(toItem));
    },
  },
];

export default routes;

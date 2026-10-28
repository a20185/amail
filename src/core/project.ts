import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Dirs } from "./paths.js";
import type { MessageRow } from "./store.js";

/** projects.d/<slug>.json 的登记内容 */
export interface ProjectConfig {
  slug: string;
  name: string;
  repos: string[];
  archiveDir: string;
}

interface ProjectFile {
  name: string;
  repos: string[];
  archiveDir: string;
}

/** 全部已登记项目（projects.d 下 *.json，slug = 文件名去后缀） */
export function loadProjects(dirs: Dirs): ProjectConfig[] {
  if (!existsSync(dirs.projectsDir)) return [];
  const out: ProjectConfig[] = [];
  for (const file of readdirSync(dirs.projectsDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dirs.projectsDir, file), "utf8")) as ProjectFile;
    out.push({ slug: basename(file, ".json"), ...raw });
  }
  return out;
}

/**
 * 按 CWD 解析项目：cwd 与某 repo 的 **realpath 全等** 才算命中。
 */
export function resolveProjectByCwd(dirs: Dirs, cwd: string): ProjectConfig | undefined {
  const realCwd = realpathSync(cwd);
  return loadProjects(dirs).find((p) => p.repos.some((repo) => realpathSync(repo) === realCwd));
}

export function projectBySlug(dirs: Dirs, slug: string): ProjectConfig | undefined {
  return loadProjects(dirs).find((p) => p.slug === slug);
}

interface AttachmentRow {
  id: string;
  blob_path: string;
  name: string;
  size: number;
  sha256: string;
}

function renderMarkdown(row: MessageRow, attachments: AttachmentRow[], attDir: string): string {
  const lines: string[] = [];
  lines.push(`# ${row.subject}`, "");
  lines.push(`- id: ${row.id}`);
  lines.push(`- from: ${row.from_addr}`);
  lines.push(`- to: ${row.to_addr}`);
  lines.push(`- createdAt: ${row.created_at}`);
  if (row.received_at) lines.push(`- receivedAt: ${row.received_at}`);
  if (row.in_reply_to) lines.push(`- inReplyTo: ${row.in_reply_to}`);
  lines.push("");
  lines.push("## 正文", "", row.body, "");
  if (row.handoff_json) lines.push("## Handoff", "", "```json", row.handoff_json, "```", "");
  if (attachments.length) {
    lines.push("## 附件", "");
    for (const att of attachments) {
      lines.push(`- ${att.name} (${att.size}B, sha256=${att.sha256}) → ${join(attDir, att.name)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 归档导出：把信（信封元数据 + 正文 + handoff）写成项目 archiveDir 内 md 文件，
 * 附件复制到 archiveDir/attachments/<messageId>/；存储真源不移动。
 * 返回 md 文件路径（库内标记由调用方 markArchived 完成）。
 */
export function exportArchive(dirs: Dirs, db: DatabaseSync, messageId: string, slug: string): string {
  const project = projectBySlug(dirs, slug);
  if (!project) throw new Error(`unknown project: ${slug}`);
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | MessageRow
    | undefined;
  if (!row) throw new Error(`unknown message: ${messageId}`);

  const attachments = db
    .prepare("SELECT id, blob_path, name, size, sha256 FROM attachments WHERE message_id = ?")
    .all(messageId) as unknown as AttachmentRow[];

  const archiveDir = project.archiveDir;
  const attDir = join(archiveDir, "attachments", messageId);
  mkdirSync(attDir, { recursive: true });
  for (const att of attachments) {
    if (att.blob_path && existsSync(att.blob_path)) {
      copyFileSync(att.blob_path, join(attDir, att.name));
    }
  }

  const mdPath = join(archiveDir, `${messageId}.md`);
  writeFileSync(mdPath, renderMarkdown(row, attachments, attDir), "utf8");
  return mdPath;
}

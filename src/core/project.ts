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

/** 落盘名总长上限（字节）：NAME_MAX 255 下留余量，避免长名 + 哈希前缀溢出 ENAMETOOLONG */
const MAX_STORED_NAME_BYTES = 200;

/** 按 UTF-8 字节截断，且不截断多字节字符中途（只按完整 code point 累积） */
function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let out = "";
  let used = 0;
  for (const char of input) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    out += char;
    used += bytes;
  }
  return out;
}

/**
 * 附件归档落盘名：原名仅取 basename，含路径分隔符/上溯段的名字整体拒绝
 * （不复制），哈希前缀防同名覆盖；原名只保留在正文元数据里。
 * 总长按 UTF-8 字节截断到 MAX_STORED_NAME_BYTES（哈希前缀 + '-' + basename），
 * 长名不再触发 ENAMETOOLONG。
 */
function archiveBlobName(att: AttachmentRow): string | undefined {
  const raw = att.name;
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) return undefined;
  const base = basename(raw);
  if (!base || base === "." || base === "..") return undefined;
  const prefix = att.sha256.slice(0, 8).replace(/[^0-9a-f]/g, "") || "blob";
  const budget = MAX_STORED_NAME_BYTES - Buffer.byteLength(`${prefix}-`, "utf8");
  const truncated = truncateUtf8(base, budget);
  if (!truncated) return undefined;
  return `${prefix}-${truncated}`;
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
      const stored = archiveBlobName(att);
      const target = stored ? join(attDir, stored) : "(未导出：非法文件名)";
      lines.push(`- ${att.name} (${att.size}B, sha256=${att.sha256}) → ${target}`);
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
    const stored = archiveBlobName(att);
    if (stored && att.blob_path && existsSync(att.blob_path)) {
      copyFileSync(att.blob_path, join(attDir, stored));
    }
  }

  const mdPath = join(archiveDir, `${messageId}.md`);
  writeFileSync(mdPath, renderMarkdown(row, attachments, attDir), "utf8");
  return mdPath;
}

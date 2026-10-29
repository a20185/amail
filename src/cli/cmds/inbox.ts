import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { resolveProjectByCwd } from "../../core/project.js";
import { apiFetch, type InboxItem } from "../util.js";

export interface InboxOptions {
  project?: string;
  unread?: boolean;
  all?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * 默认视图：未归档 + 当前项目归档件合并（daemon 端合并）。
 * --project 显式覆盖 resolveProjectByCwd。
 */
export async function showInbox(options: InboxOptions = {}): Promise<InboxItem[]> {
  const dirs = resolveDirs(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  const project = options.project ?? resolveProjectByCwd(dirs, cwd)?.slug;

  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (options.unread) params.set("unread", "true");
  if (options.all) params.set("all", "true");
  const qs = params.size > 0 ? `?${params}` : "";

  const items = (await apiFetch(dirs, `/v1/inbox${qs}`)) as InboxItem[];
  for (const item of items) {
    const flag = item.unread ? "*" : " ";
    console.log(`${flag} ${item.id}  ${item.receivedAt}  ${item.from}  ${item.subject}`);
  }
  if (items.length === 0) console.log("inbox empty");
  return items;
}

export default function register(program: Command): void {
  program
    .command("inbox")
    .description("list inbox (unarchived + current project's archived, merged by daemon)")
    .option("--project <slug>", "explicit project (overrides cwd resolution)")
    .option("--unread", "unread only")
    .option("--all", "all messages")
    .action(async (opts: { project?: string; unread?: boolean; all?: boolean }) => {
      await showInbox(opts);
    });
}

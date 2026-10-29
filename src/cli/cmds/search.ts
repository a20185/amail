import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch, type InboxItem } from "../util.js";

export async function searchMessages(q: string, env: NodeJS.ProcessEnv = process.env): Promise<InboxItem[]> {
  const items = (await apiFetch(
    resolveDirs(env),
    `/v1/search?q=${encodeURIComponent(q)}`,
  )) as InboxItem[];
  for (const item of items) {
    const flag = item.unread ? "*" : " ";
    console.log(`${flag} ${item.id}  ${item.receivedAt}  ${item.from}  ${item.subject}`);
  }
  if (items.length === 0) console.log("no matches");
  return items;
}

export default function register(program: Command): void {
  program
    .command("search")
    .description("full-text search messages")
    .requiredOption("--q <text>", "search query")
    .action(async (opts: { q: string }) => {
      await searchMessages(opts.q);
    });
}

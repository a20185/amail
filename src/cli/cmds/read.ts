import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";

export interface MessageView {
  id: string;
  from: string;
  to: string;
  subject: string;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  project: string | null;
  body: string;
  handoff: unknown;
  attachments: Array<{ id: string; name: string; size: number; blob_path?: string }>;
}

export interface ReadOptions {
  keepUnread?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * 读取一封信：GET /v1/message/:id；未传 --keep-unread 才 POST /v1/read
 * （回执由 daemon 侧首次门槛控制，重复 read 不重发）。
 */
export async function readMessage(id: string, options: ReadOptions = {}): Promise<MessageView> {
  const dirs = resolveDirs(options.env ?? process.env);
  const message = (await apiFetch(dirs, `/v1/message/${encodeURIComponent(id)}`)) as MessageView;
  if (!options.keepUnread) {
    await apiFetch(dirs, "/v1/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  console.log(`# ${message.subject}`);
  console.log(`- id: ${message.id}`);
  console.log(`- from: ${message.from}`);
  console.log(`- to: ${message.to}`);
  console.log(`- createdAt: ${message.createdAt}`);
  console.log(`- readAt: ${message.readAt}`);
  if (message.archivedAt) console.log(`- archivedAt: ${message.archivedAt} (project=${message.project})`);
  console.log("");
  console.log(message.body);
  if (message.handoff) {
    console.log("");
    console.log("## Handoff");
    console.log("```json");
    console.log(JSON.stringify(message.handoff, null, 2));
    console.log("```");
  }
  if (message.attachments.length > 0) {
    console.log("");
    console.log("## 附件");
    for (const att of message.attachments) {
      console.log(`- ${att.name} (${att.size}B) → ${att.blob_path ?? att.id}`);
    }
  }
  return message;
}

export default function register(program: Command): void {
  program
    .command("read")
    .description("read a message (marks read and sends receipt unless --keep-unread)")
    .argument("<id>", "message id")
    .option("--keep-unread", "do not mark read / send receipt")
    .action(async (id: string, opts: { keepUnread?: boolean }) => {
      await readMessage(id, opts);
    });
}

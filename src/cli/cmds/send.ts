import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";

export interface SendOptions {
  subject?: string;
  body?: string;
  refs?: string[];
  inReplyTo?: string;
  handoff?: { progress: string; description: string; questions: string[] };
  env?: NodeJS.ProcessEnv;
}

export interface SendResult {
  messageId: string;
}

/**
 * amail send <to> --subject --body [--ref path]…：
 * refs → 附件元数据 + parts 密封（daemon 组装 DeliverReq 并入出箱）。
 */
export async function runSend(to: string, options: SendOptions = {}): Promise<SendResult> {
  if (!options.subject || !options.body) {
    throw new Error("--subject and --body are required");
  }
  const dirs = resolveDirs(options.env ?? process.env);
  const result = (await apiFetch(dirs, "/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      to,
      subject: options.subject,
      body: options.body,
      inReplyTo: options.inReplyTo,
      refs: options.refs ?? [],
      handoff: options.handoff,
    }),
  })) as SendResult;
  console.log(`已入出箱：${result.messageId} → ${to}`);
  return result;
}

export default function register(program: Command): void {
  program
    .command("send")
    .description("send a message to a paired peer (queued in outbox, delivered by daemon)")
    .argument("<to>", "recipient address user@device")
    .requiredOption("--subject <subject>", "message subject")
    .requiredOption("--body <body>", "message body")
    .option("--ref <path>", "attachment file path (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .action(async (to: string, opts: { subject: string; body: string; ref: string[] }) => {
      await runSend(to, { subject: opts.subject, body: opts.body, refs: opts.ref });
    });
}

import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";
import { runSend } from "./send.js";
import type { MessageView } from "./read.js";

export interface ReplyOptions {
  body?: string;
  refs?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * amail reply <msgId> --body [--ref]…：
 * inReplyTo/thread 链接续 —— 回给原信发件人，references 由 daemon 串联。
 */
export async function runReply(messageId: string, options: ReplyOptions = {}): Promise<{ messageId: string }> {
  if (!options.body) throw new Error("--body is required");
  const dirs = resolveDirs(options.env ?? process.env);
  const original = (await apiFetch(dirs, `/v1/message/${encodeURIComponent(messageId)}`)) as Pick<
    MessageView,
    "from" | "subject"
  >;
  const subject = original.subject.startsWith("Re: ") ? original.subject : `Re: ${original.subject}`;
  return runSend(original.from, {
    subject,
    body: options.body,
    refs: options.refs,
    inReplyTo: messageId,
    env: options.env,
  });
}

export default function register(program: Command): void {
  program
    .command("reply")
    .description("reply to a message (links inReplyTo/thread)")
    .argument("<msgId>", "message id to reply to")
    .requiredOption("--body <body>", "reply body")
    .option("--ref <path>", "attachment file path (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .action(async (msgId: string, opts: { body: string; ref: string[] }) => {
      await runReply(msgId, opts);
    });
}

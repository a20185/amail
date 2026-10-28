import type { Command } from "commander";
import { runSend } from "./send.js";

export interface HandoffOptions {
  progress?: string;
  description?: string;
  question?: string[];
  refs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface HandoffResult {
  messageId: string;
}

/** 缺省摘要：description 未给时由 progress/questions 拼出正文 */
function defaultSummary(progress: string, questions: string[]): string {
  return ["[handoff]", `进度：${progress}`, questions.map((q) => `待决：${q}`).join("\n")].join("\n");
}

/**
 * amail handoff <to> --progress --description --question… [--ref]…：
 * 三字段打包成 handoff 块随密封体发出；body 为 --description 或缺省摘要。
 */
export async function runHandoff(to: string, options: HandoffOptions = {}): Promise<HandoffResult> {
  if (!options.progress || !options.question?.length) {
    throw new Error("--progress and at least one --question are required");
  }
  const questions = options.question;
  const handoff = {
    progress: options.progress,
    description: options.description ?? "",
    questions,
  };
  return runSend(to, {
    subject: `[handoff] ${options.progress.slice(0, 40)}`,
    body: options.description ?? defaultSummary(options.progress, questions),
    refs: options.refs,
    env: options.env,
    handoff,
  });
}

export default function register(program: Command): void {
  program
    .command("handoff")
    .description("hand off in-flight work to another agent (sealed handoff block)")
    .argument("<to>", "recipient address user@device")
    .requiredOption("--progress <text>", "what is done and where things stand")
    .option("--description <text>", "full task description for the receiver")
    .requiredOption("--question <text>", "open question for the receiver (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--ref <path>", "attachment file path (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .action(async (to: string, opts: { progress: string; description?: string; question: string[]; ref?: string[] }) => {
      await runHandoff(to, opts);
    });
}

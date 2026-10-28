import { spawn } from "node:child_process";

export interface NotifyEnv {
  AMAIL_NOTIFY_CMD?: string;
  [key: string]: string | undefined;
}
export interface NotifyOptions {
  env?: NotifyEnv;
  platform?: NodeJS.Platform;
}

/** osascript 字符串字面量转义（反斜杠 + 双引号） */
function applescriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const child = spawn(cmd, args, {
    stdio: "ignore",
    env: { ...process.env, ...extraEnv },
  });
  child.on("error", () => resolve()); // 通知失败不应影响主流程
  child.on("exit", () => resolve());
  return promise;
}

/**
 * 桌面通知原语：
 * - AMAIL_NOTIFY_CMD 覆盖（测试/自定义）：命令以 shell 执行，
 *   标题/正文经 AMAIL_TITLE / AMAIL_BODY 环境变量传入；
 * - darwin：osascript display notification；
 * - linux：notify-send；
 * - 其他平台 no-op。
 */
export async function notify(title: string, body: string, options: NotifyOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const cmd = env.AMAIL_NOTIFY_CMD;
  if (cmd) {
    await run("/bin/sh", ["-c", cmd], { ...env, AMAIL_TITLE: title, AMAIL_BODY: body });
    return;
  }

  if (platform === "darwin") {
    await run("osascript", [
      "-e",
      `display notification ${applescriptQuote(body)} with title ${applescriptQuote(title)}`,
    ]);
    return;
  }
  if (platform === "linux") {
    await run("notify-send", [title, body]);
    return;
  }
  // 其他平台：no-op
}

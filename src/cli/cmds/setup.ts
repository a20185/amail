import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { buildClaim, fingerprint, loadOrCreateIdentity } from "../../core/identity.js";
import { installDaemon } from "./daemon.js";

/** git user.name → 地址用户名：小写 → 空格换连字符 → 删 AddressSchema 禁止字符（空白与 @）→ 空回退 user */
export function mapGitNameToUser(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[\s@]+/g, "");
  return cleaned || "user";
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** 读 git 身份：--global 优先，缺则 --local，再缺用占位 */
export function readGitIdentity(env: NodeJS.ProcessEnv, cwd: string): GitIdentity {
  const read = (scope: string, key: string): string | undefined => {
    const r = spawnSync("git", ["config", scope, key], { env, cwd, encoding: "utf8" });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out || undefined;
  };
  const pick = (key: string, fallback: string): string =>
    read("--global", key) ?? read("--local", key) ?? fallback;
  return { name: pick("user.name", "user"), email: pick("user.email", "user@example.com") };
}

async function confirmInstall(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("install daemon now? [y/N] ", resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export interface SetupOptions {
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onInstallDaemon?: () => unknown;
  /** 测试缝：非 TTY 下回答安装询问；未提供且无 TTY 视为否 */
  installAnswer?: boolean;
}

export interface SetupResult {
  address: string;
  fingerprint: string;
  created: boolean;
}

/**
 * 两级初始化的第一级：密钥 → git 身份 → claim+config.json → （交互）daemon install。
 * 幂等：已初始化（config.json 存在）则只刷新声明。
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const dirs = resolveDirs(env);
  const identity = loadOrCreateIdentity(dirs);
  const existing = existsSync(join(dirs.configDir, "config.json"));

  const git = readGitIdentity(env, options.cwd ?? process.cwd());
  let name = git.name;
  let email = git.email;

  if (!existing && !options.yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (prompt: string, def: string): Promise<string> =>
      new Promise((resolve) => rl.question(`${prompt} [${def}]: `, (a) => resolve(a.trim() || def)));
    name = await ask("name", name);
    email = await ask("email", email);
    rl.close();
  }

  const { claim, sig } = buildClaim(identity.signPrivPem, name, email);
  writeFileSync(
    join(dirs.configDir, "claim.json"),
    JSON.stringify({ claim, sig, deviceId: identity.deviceId }, null, 2) + "\n",
    "utf8",
  );

  if (!existing) {
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify({ version: 1, name, email, port: 36969, notify: true }, null, 2) + "\n",
      "utf8",
    );
  }

  const user = mapGitNameToUser(name);
  const address = `${user}@${identity.deviceName}`;

  if (!existing && !options.yes) {
    const doInstall = options.installAnswer ?? (process.stdin.isTTY ? await confirmInstall() : false);
    if (doInstall) {
      await options.onInstallDaemon?.();
    }
  }

  console.log(`address:     ${address}`);
  console.log(`fingerprint: ${fingerprint(identity.signPubPem)}`);
  console.log(`claim:       ${claim.name} <${claim.email}>`);
  if (existing) {
    console.log("already initialized — claim refreshed");
  } else {
    console.log(`next: try \`amail skill\` for agent-side usage, or \`amail daemon\` to start`);
  }
  return { address, fingerprint: fingerprint(identity.signPubPem), created: !existing };
}

export default function register(program: Command): void {
  program
    .command("setup")
    .description("initialize device identity, claim and config")
    .option("--yes", "non-interactive: skip prompts and daemon-install question")
    .action(async (opts: { yes?: boolean }) => {
      await runSetup({ yes: opts.yes, onInstallDaemon: () => installDaemon({}) });
    });
}

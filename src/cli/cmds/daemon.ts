import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { DaemonAlreadyRunningError, startDaemon } from "../../daemon/server.js";
import { daemonPort } from "../util.js";

/** CLI 入口绝对路径：cmds/daemon.js → ../main.js（构建后 dist/cli/main.js） */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../main.js", import.meta.url));
}

export interface InstallOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
  configPath: string;
  commands: string[];
}

function darwinPlist(entry: string, port: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.amail.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/amail-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/amail-daemon.err.log</string>
</dict>
</plist>
`;
}

function linuxUnit(entry: string, port: number): string {
  return `[Unit]
Description=amail daemon
After=network.target

[Service]
ExecStart=${process.execPath} ${entry} daemon --port ${port}
Restart=always

[Install]
WantedBy=default.target
`;
}

/** 守护进程安装：darwin=launchd，linux=systemd user；--dry-run 只打印不落盘 */
export function installDaemon(options: InstallOptions = {}): InstallResult {
  const env = options.env ?? process.env;
  const dirs = resolveDirs(env);
  const port = daemonPort(dirs);
  const entry = cliEntryPath();
  const platform = process.platform;

  let configPath: string;
  let content: string;
  let commands: string[];
  if (platform === "darwin") {
    configPath = join(env.HOME ?? homedir(), "Library", "LaunchAgents", "com.amail.daemon.plist");
    content = darwinPlist(entry, port);
    commands = ["launchctl unload -w " + configPath, "launchctl load -w " + configPath];
  } else if (platform === "linux") {
    configPath = join(env.HOME ?? homedir(), ".config", "systemd", "user", "amail.service");
    content = linuxUnit(entry, port);
    commands = ["systemctl --user daemon-reload", "systemctl --user enable --now amail.service"];
  } else {
    throw new Error(`unsupported platform for daemon install: ${platform}`);
  }

  if (options.dryRun) {
    console.log(`[dry-run] would write ${configPath}:`);
    console.log(content);
    for (const cmd of commands) console.log(`[dry-run] $ ${cmd}`);
    return { configPath, commands };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, content, "utf8");
  for (const cmd of commands) {
    const [bin, ...args] = cmd.split(" ");
    const r = spawnSync(bin!, args, { env, encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`warn: \`${cmd}\` failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
  }
  console.log(`daemon installed → ${configPath}`);
  return { configPath, commands };
}

export interface StatusResult {
  running: boolean;
  pid: number | null;
  alive: boolean;
  port: number;
}

/** pid 锁 + /alive 探活 */
export async function daemonStatus(env: NodeJS.ProcessEnv = process.env): Promise<StatusResult> {
  const dirs = resolveDirs(env);
  const pidPath = join(dirs.dataDir, "daemon.pid");
  let pid: number | null = null;
  if (existsSync(pidPath)) {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid)) pid = null;
  }
  let alive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort(dirs)}/alive`);
    alive = res.ok;
  } catch {
    alive = false;
  }
  const result = { running: pid !== null || alive, pid, alive, port: daemonPort(dirs) };
  console.log(
    result.running
      ? `daemon running (pid=${pid ?? "?"}, /alive=${alive}, port=${result.port})`
      : `daemon not running (port=${result.port})`,
  );
  return result;
}

export async function daemonStop(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const dirs = resolveDirs(env);
  const pidPath = join(dirs.dataDir, "daemon.pid");
  if (!existsSync(pidPath)) {
    console.log("daemon not running (no pid file)");
    return false;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (!Number.isInteger(pid)) {
    console.log("daemon not running (corrupt pid file)");
    return false;
  }
  process.kill(pid, "SIGTERM");
  console.log(`daemon stopped (pid=${pid})`);
  return true;
}

/** 前台运行；pid 锁被占 → DaemonAlreadyRunningError{exitCode:3} 由调用方映射进程退出码 */
export async function runForeground(port?: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dirs = resolveDirs(env);
  const handle = await startDaemon({ port, dirs });
  console.log(`amail daemon listening on [::]:${handle.port} — ${handle.address}`);
  const { promise, resolve } = Promise.withResolvers<void>();
  const shutdown = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void handle.stop().finally(resolve);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await promise;
}

export default function register(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("daemon management (foreground by default)")
    .option("--port <number>", "listen port", Number)
    .action(async (opts: { port?: number }) => {
      try {
        await runForeground(opts.port);
      } catch (err) {
        if (err instanceof DaemonAlreadyRunningError) {
          console.error(`amail: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  daemon
    .command("install")
    .description("install daemon as launchd/systemd user service")
    .option("--dry-run", "print actions without writing")
    .action(async (opts: { dryRun?: boolean }) => {
      installDaemon({ dryRun: opts.dryRun });
    });

  daemon
    .command("status")
    .description("show daemon pid/alive status")
    .action(async () => {
      await daemonStatus();
    });

  daemon
    .command("stop")
    .description("stop the running daemon")
    .action(async () => {
      await daemonStop();
    });
}

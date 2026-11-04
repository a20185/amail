import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { daemonStatus, daemonStop, installDaemon, portMismatchNotice } from "../../cli/cmds/daemon.js";
import { DaemonAlreadyRunningError, startDaemon } from "../../daemon/server.js";
import { resolveDirs } from "../../core/paths.js";
import { sandboxEnv, startStub, writeConfig } from "../testkit.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const stubs: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stubs.splice(0)) await stop();
});

describe("installDaemon", () => {
  it("--dry-run prints the service file and commands without writing", () => {
    const { home, env } = sandboxEnv();
    const result = installDaemon({ dryRun: true, env });
    if (process.platform === "darwin") {
      expect(result.configPath).toBe(join(home, "Library", "LaunchAgents", "com.amail.daemon.plist"));
      expect(result.commands.join(" ")).toContain("launchctl load");
      expect(existsSync(result.configPath)).toBe(false);
    } else if (process.platform === "linux") {
      expect(result.configPath).toBe(join(home, ".config", "systemd", "user", "amail.service"));
      expect(result.commands.join(" ")).toContain("systemctl --user enable --now amail.service");
      expect(existsSync(result.configPath)).toBe(false);
    }
  });
});

describe("daemonStatus / daemonStop", () => {
  it("status: alive via stub daemon /alive probe", async () => {
    const { home, env } = sandboxEnv();
    const { handle } = await startStub(home);
    stubs.push(() => handle.stop());
    const status = await daemonStatus(env);
    expect(status.running).toBe(true);
    expect(status.alive).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(handle.port);
  });

  it("status: not running when no daemon", async () => {
    const { home, env } = sandboxEnv();
    writeConfig(home, 1); // 显式用关闭端口：避免本机真 daemon 干扰（36969 可能被开发机占用）
    const status = await daemonStatus(env);
    expect(status.running).toBe(false);
    expect(status.alive).toBe(false);
  });

  it("stop: SIGTERMs the pid in the lock file", async () => {
    const { home, env } = sandboxEnv();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const dirs = resolveDirs({ AMAIL_HOME: home });
    writeFileSync(join(dirs.dataDir, "daemon.pid"), `${child.pid}\n`);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const stopped = await daemonStop(env);
    expect(stopped).toBe(true);
    await exited;
  });
});

describe("pid lock mapping", () => {
  it("a live foreign pid makes startDaemon throw DaemonAlreadyRunningError{exitCode:3}", async () => {
    const { home, env } = sandboxEnv();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const dirs = resolveDirs({ AMAIL_HOME: home });
    writeFileSync(join(dirs.dataDir, "daemon.pid"), `${child.pid}\n`);
    const err = await startDaemon({ dirs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((err as DaemonAlreadyRunningError).exitCode).toBe(3);
    child.kill();
  });
});

describe("portMismatchNotice", () => {
  it("--port 与 config.port 不一致时提示客户端仍读 config.port；一致/未覆盖无提示", () => {
    const notice = portMismatchNotice(40000, 36969);
    expect(notice).toBeDefined();
    expect(notice).toContain("config.port");
    expect(notice).toContain("36969");
    expect(portMismatchNotice(36969, 36969)).toBeUndefined();
    expect(portMismatchNotice(undefined, 36969)).toBeUndefined();
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 终止保证（spawn 真实构建产物）：AMAIL_MDNS_FAKE=always-fail 注入一个"广告永不完成 +
 * 无 unref 重试定时器"的上游，复现 ciao 1.3.12 探测失败后不可取消的退避重试。
 * 该定时器让事件循环永不自然清空，因此进程只能靠终止路径的显式 process.exit 结束。
 */
describe("终止保证：SIGTERM 后进程必然退出（ciao 退避重试泄漏兜底）", () => {
  let entry: string;

  beforeAll(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "amail-terminate-"));
    const out = join(tmp, "dist");
    await execFileAsync(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
        "-p",
        join(REPO_ROOT, "tsconfig.json"),
        "--outDir",
        out,
        "--declaration",
        "false",
      ],
      { cwd: REPO_ROOT },
    );
    // 临时构建目录的 ESM 语义与依赖解析（同 main.test.ts 的 bin 级集成）
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"), "dir");
    entry = join(out, "cli", "main.js");
  }, 60_000);

  it(
    "SIGTERM → cleanup（disposer/bus/db/pid）→ exit 0，即使泄漏定时器仍在",
    async () => {
      const { home, env } = sandboxEnv();
      const child = spawn(process.execPath, [entry, "daemon", "--port", "0"], {
        env: { ...env, AMAIL_MDNS_FAKE: "always-fail", AMAIL_NOTIFY_CMD: ":" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.resume();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      try {
        const deadline = Date.now() + 10_000;
        while (!stdout.includes("daemon listening") && Date.now() < deadline) await delay(20);
        expect(stdout).toContain("daemon listening"); // 上游失败已降级，daemon 正常就绪

        const pidPath = join(resolveDirs({ AMAIL_HOME: home }).dataDir, "daemon.pid");
        expect(existsSync(pidPath)).toBe(true);

        child.kill("SIGTERM");
        const result = await Promise.race([exited, delay(2_000).then(() => null)]);
        // 若无显式退出，泄漏的 ref 定时器会拖住事件循环 → 2s 内不退出
        expect(result).toEqual({ code: 0, signal: null });
        expect(existsSync(pidPath)).toBe(false); // 退出前 cleanup 已跑完
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    30_000,
  );
});

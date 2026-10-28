import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { daemonStatus, daemonStop, installDaemon } from "../../cli/cmds/daemon.js";
import { DaemonAlreadyRunningError, startDaemon } from "../../daemon/server.js";
import { resolveDirs } from "../../core/paths.js";
import { sandboxEnv, startStub, writeConfig } from "../testkit.js";

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
    writeConfig(home, 36969);
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

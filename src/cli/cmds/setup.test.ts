import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mapGitNameToUser, readGitIdentity, runSetup } from "../../cli/cmds/setup.js";
import { normalizeUser, userAddress } from "../../daemon/server.js";
import { loadOrCreateIdentity } from "../../core/identity.js";
import { resolveDirs } from "../../core/paths.js";
import { sandboxEnv } from "../testkit.js";

describe("mapGitNameToUser", () => {
  it("lowercases, spaces→hyphens, drops AddressSchema-forbidden chars (@)", () => {
    expect(mapGitNameToUser("Zhang San@Corp")).toBe("zhang-sancorp");
    expect(mapGitNameToUser("Alice Cooper")).toBe("alice-cooper");
    expect(mapGitNameToUser("bob")).toBe("bob");
  });
  it("empty result falls back to user", () => {
    expect(mapGitNameToUser("@@@")).toBe("user");
    expect(mapGitNameToUser("")).toBe("user");
  });
});

describe("normalizeUser 一致性（setup 展示 = daemon 实际地址）", () => {
  it("mapGitNameToUser 与 normalizeUser 同规则；userAddress 使用同一规则", () => {
    for (const name of ["Zhang San@Corp", "Alice Cooper", "bob", "@@@", "  A  B  ", "Ünïcode Name"]) {
      expect(mapGitNameToUser(name), name).toBe(normalizeUser(name));
    }

    const { home } = sandboxEnv();
    const dirs = resolveDirs({ AMAIL_HOME: home });
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify({ version: 1, name: "Zhang San@Corp", email: "z@example.com", port: 36969, notify: true }),
      "utf8",
    );
    const identity = loadOrCreateIdentity(dirs);
    expect(userAddress(dirs, identity)).toBe(`zhang-sancorp@${identity.deviceName}`);
  });
});

describe("readGitIdentity", () => {
  it("reads --global from the sandbox HOME, falls back to --local, then placeholders", () => {
    const { home, env } = sandboxEnv();
    expect(readGitIdentity(env, home)).toEqual({ name: "user", email: "user@example.com" });

    // --local 兜底
    const repo = join(home, "repo");
    mkdirSync(repo);
    execSync("git init -q", { cwd: repo, env });
    execSync('git config user.name "Local Person"', { cwd: repo, env });
    execSync("git config user.email local@example.com", { cwd: repo, env });
    expect(readGitIdentity(env, repo)).toEqual({ name: "Local Person", email: "local@example.com" });

    // --global 优先于 --local
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Global One\n\temail = g@example.com\n");
    expect(readGitIdentity(env, repo)).toEqual({ name: "Global One", email: "g@example.com" });
  });
});

describe("runSetup", () => {
  it("--yes writes claim + config.json, derives address, skips install prompt", async () => {
    const { home, env } = sandboxEnv();
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Zhang San@Corp\n\temail = z@example.com\n");
    const result = await runSetup({ yes: true, env, cwd: home });
    expect(result.created).toBe(true);

    const dirs = resolveDirs({ AMAIL_HOME: home });
    const config = JSON.parse(readFileSync(join(dirs.configDir, "config.json"), "utf8"));
    expect(config).toEqual({ version: 1, name: "Zhang San@Corp", email: "z@example.com", port: 36969, notify: true });
    const claimFile = JSON.parse(readFileSync(join(dirs.configDir, "claim.json"), "utf8"));
    expect(claimFile.claim).toEqual({ name: "Zhang San@Corp", email: "z@example.com" });
    expect(claimFile.sig).toBeTruthy();
    expect(result.address).toBe("zhang-sancorp@" + result.address.split("@")[1]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(dirs.keysDir, "device.pem"))).toBe(true);
  });

  it("idempotent: second run only refreshes the claim, config untouched", async () => {
    const { home, env } = sandboxEnv();
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = First Name\n\temail = f@example.com\n");
    await runSetup({ yes: true, env, cwd: home });

    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Second Name\n\temail = s@example.com\n");
    const dirs = resolveDirs({ AMAIL_HOME: home });
    const configBefore = readFileSync(join(dirs.configDir, "config.json"), "utf8");
    const result = await runSetup({ yes: true, env, cwd: home });
    expect(result.created).toBe(false);
    expect(readFileSync(join(dirs.configDir, "config.json"), "utf8")).toBe(configBefore);
    const claimFile = JSON.parse(readFileSync(join(dirs.configDir, "claim.json"), "utf8"));
    expect(claimFile.claim.name).toBe("Second Name");
  });

  it("answering the install question triggers the daemon install callback", async () => {
    const { home, env } = sandboxEnv();
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = I N\n\temail = i@example.com\n");
    let installed = 0;
    const result = await runSetup({
      env,
      cwd: home,
      installAnswer: true,
      onInstallDaemon: () => void installed++,
    });
    expect(result.created).toBe(true);
    expect(installed).toBe(1);
  });

  it("--yes skips the daemon-install question (no install)", async () => {
    const { home, env } = sandboxEnv();
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = I N\n\temail = i@example.com\n");
    let installed = 0;
    await runSetup({ yes: true, env, cwd: home, onInstallDaemon: () => void installed++ });
    expect(installed).toBe(0);
  });
});

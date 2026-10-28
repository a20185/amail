import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs } from "./paths.js";

const sandboxes: string[] = [];
afterEach(() => {
  // leave sandboxes for post-mortem; OS tmp cleanup handles them
  void sandboxes;
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "amail-paths-"));
  sandboxes.push(dir);
  return dir;
}

describe("resolveDirs", () => {
  it("AMAIL_HOME 沙箱：全部路径落在 $AMAIL_HOME 下并自动 mkdir 0700", () => {
    const home = sandbox();
    const dirs = resolveDirs({ AMAIL_HOME: home });
    expect(dirs.home).toBe(home);
    expect(dirs.configDir).toBe(join(home, "config"));
    expect(dirs.dataDir).toBe(join(home, "data"));
    expect(dirs.projectsDir).toBe(join(home, "config", "projects.d"));
    expect(dirs.storePath).toBe(join(home, "data", "store.db"));
    expect(dirs.attachmentsDir).toBe(join(home, "data", "attachments"));
    expect(dirs.keysDir).toBe(join(home, "data", "keys"));
    expect(dirs.peersDir).toBe(join(home, "data", "peers"));
    for (const dir of [dirs.configDir, dirs.dataDir, dirs.projectsDir, dirs.attachmentsDir, dirs.keysDir, dirs.peersDir]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  it("AMAIL_HOME 沙箱下 keys 目录权限 0700", () => {
    const dirs = resolveDirs({ AMAIL_HOME: sandbox() });
    const mode = statSync(dirs.keysDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("~/.config 存在时走 XDG 布局（config/amail + local/share/amail）", () => {
    const home = sandbox();
    mkdirSync(join(home, ".config"));
    const dirs = resolveDirs({ HOME: home });
    expect(dirs.configDir).toBe(join(home, ".config", "amail"));
    expect(dirs.dataDir).toBe(join(home, ".local", "share", "amail"));
    expect(dirs.storePath).toBe(join(home, ".local", "share", "amail", "store.db"));
  });

  it("无 ~/.config 时统一落 ~/.amail/", () => {
    const home = sandbox();
    const dirs = resolveDirs({ HOME: home });
    expect(dirs.configDir).toBe(join(home, ".amail"));
    expect(dirs.dataDir).toBe(join(home, ".amail"));
  });

  it("缺 HOME 与 AMAIL_HOME 时抛错", () => {
    expect(() => resolveDirs({})).toThrow();
  });
});


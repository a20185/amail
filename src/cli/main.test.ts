import { mkdtempSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { defaultCmdsDir, isMainEntry, loadCmds } from "./main.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function injectedDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "amail-cmds-"));
  writeFileSync(
    join(dir, "alpha.js"),
    `export default (p) => p.command("alpha").action(() => {});\n`,
  );
  writeFileSync(
    join(dir, "beta.js"),
    `export default (p) => p.command("beta").action(() => {});\n`,
  );
  writeFileSync(
    join(dir, "beta.test.js"),
    `export default (p) => p.command("should-not-load").action(() => {});\n`,
  );
  writeFileSync(join(dir, "ignored.txt"), "not a module\n");
  return dir;
}

describe("loadCmds", () => {
  it("discovers cmd modules in an injected dir, skipping tests and non-modules", async () => {
    const program = new Command();
    const names = await loadCmds(program, await injectedDir());
    expect(names).toEqual(["alpha", "beta"]);
    expect(program.commands.map((c) => c.name())).toEqual(["alpha", "beta"]);
  });

  it("rejects modules without a default register export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amail-cmds-"));
    writeFileSync(join(dir, "bad.js"), "export const nope = 1;\n");
    const program = new Command();
    await expect(loadCmds(program, dir)).rejects.toThrow(/must default-export/);
  });

  it("default discovery base is the sibling cmds/ dir of main.ts", () => {
    expect(defaultCmdsDir()).toMatch(/src\/cli\/cmds$/);
    expect(existsSync(defaultCmdsDir())).toBe(true);
  });
});

describe("isMainEntry（bin 符号链接入口）", () => {
  it("argv[1] 为指向入口的符号链接时仍判定为入口；其他文件不是", () => {
    const dir = mkdtempSync(join(tmpdir(), "amail-entry-"));
    const real = join(dir, "real-main.js");
    writeFileSync(real, "// entry\n");
    const link = join(dir, "amail");
    symlinkSync(real, link);

    expect(isMainEntry(link, pathToFileURL(real).href)).toBe(true);
    expect(isMainEntry(real, pathToFileURL(real).href)).toBe(true);
    expect(isMainEntry(join(dir, "other.js"), pathToFileURL(real).href)).toBe(false);
    expect(isMainEntry(undefined, pathToFileURL(real).href)).toBe(false);
  });

  it(
    "bin 级集成：临时目录建符号链接 spawn 真实 bin --help（npm 安装形态）",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "amail-bin-"));
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
      // 临时构建目录的 ESM 语义与依赖解析
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
      symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"), "dir");

      const linkedBin = join(tmp, "amail");
      symlinkSync(join(out, "cli", "main.js"), linkedBin, "file");
      const { stdout } = await execFileAsync(process.execPath, [linkedBin, "--help"]);
      expect(stdout).toContain("Usage: amail");
      expect(stdout).toContain("ws");
    },
    60_000,
  );
});

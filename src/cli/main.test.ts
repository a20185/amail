import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { defaultCmdsDir, loadCmds } from "./main.js";

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

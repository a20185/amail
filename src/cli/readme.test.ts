import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { loadCmds } from "./main.js";

const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const DIST_MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

/** README 命令表里记录的每一条命令（第一个单元格） */
function readmeCommands(): string[] {
  const text = readFileSync(README, "utf8");
  const start = text.indexOf("## 命令表");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + "## 命令表".length);
  const nextHeading = rest.indexOf("\n## ");
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const commands: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/);
    const cell = (cells[1] ?? "").trim();
    const match = /^`(.+)`$/.exec(cell);
    if (match) commands.push(match[1]!.replaceAll("\\", ""));
  }
  return commands;
}

async function buildProgram(): Promise<Command> {
  const program = new Command().name("amail");
  await loadCmds(program);
  return program;
}

/** 逐 token 走 commander 命令树，断言子命令与选项都真实存在 */
function assertCommandExists(program: Command, line: string): void {
  const tokens = line.split(/\s+/).slice(1); // 跳过 amail
  let cmd = program;
  for (let i = 0; i < tokens.length; i += 1) {
    const bare = tokens[i]!.replace(/[[\]]/g, "").replace(/…+$/, "");
    if (bare.startsWith("-")) {
      const known = cmd.options.some((o) => o.short === bare || o.long === bare);
      expect(known, `${line}: unknown option ${bare} for \`${cmd.name()}\``).toBe(true);
      const next = tokens[i + 1];
      if (next && next.replace(/[[\]]/g, "").startsWith("<")) i += 1;
      continue;
    }
    if (bare.startsWith("<") || bare.length === 0) continue;
    const sub = cmd.commands.find((c) => c.name() === bare);
    expect(sub, `${line}: unknown subcommand ${bare} for \`${cmd.name()}\``).toBeDefined();
    cmd = sub!;
  }
}

describe("README 命令表 vs CLI help", () => {
  it("命令表逐条可在 commander 命令树中找到（含每个选项）", async () => {
    const program = await buildProgram();
    const commands = readmeCommands();
    expect(commands.length).toBeGreaterThan(20);
    for (const line of commands) assertCommandExists(program, line);
  });

  it("全部顶层命令组都在命令表中有至少一条记录", async () => {
    const program = await buildProgram();
    const commands = readmeCommands();
    for (const cmd of program.commands) {
      if (cmd.name() === "help") continue;
      expect(
        commands.some((line) => line === `amail ${cmd.name()}` || line.startsWith(`amail ${cmd.name()} `)),
        `top-level command \`${cmd.name()}\` missing from README command table`,
      ).toBe(true);
    }
    // 新阶段的两个命令组
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("artifact");
    expect(names).toContain("ws");
  });

  it.skipIf(!existsSync(DIST_MAIN))("构建产物 `node dist/cli/main.js --help` 输出含全部命令组", async () => {
    const program = await buildProgram();
    const out = execFileSync(process.execPath, [DIST_MAIN, "--help"], { encoding: "utf8" });
    for (const cmd of program.commands) {
      if (cmd.name() === "help") continue;
      expect(out).toContain(cmd.name());
    }
    expect(out).toMatch(/artifact .*workspace artifacts/);
  });
});

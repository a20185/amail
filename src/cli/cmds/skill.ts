import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

export interface SkillInstallOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SkillStatusEntry {
  name: string;
  packageVersion: string | null;
  installedVersion: string | null;
  installed: boolean;
}

/** 包内 skills/ 根目录（dist/cli/cmds/skill.js 与 src/cli/cmds/skill.ts 同为 ../../../skills） */
export function packageSkillsDir(): string {
  return fileURLToPath(new URL("../../../skills", import.meta.url));
}

export function defaultInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AMAIL_SKILLS_DIR) return env.AMAIL_SKILLS_DIR;
  return join(homedir(), ".claude", "skills");
}

/** 解析 SKILL.md frontmatter（name/description/version） */
export async function parseFrontmatter(
  skillMdPath: string,
): Promise<{ name?: string; description?: string; version?: string }> {
  const text = await readFile(skillMdPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

/** 包内全部技能目录（扫目录，不写死单目录：P8 新增技能自动进入安装面） */
export async function packageSkillNames(skillsDir: string = packageSkillsDir()): Promise<string[]> {
  const entries = await readdir(skillsDir);
  return entries
    .filter((e) => statSync(join(skillsDir, e)).isDirectory())
    .filter((e) => existsSync(join(skillsDir, e, "SKILL.md")))
    .sort();
}

async function readVersion(skillDir: string): Promise<string | null> {
  if (!existsSync(join(skillDir, "SKILL.md"))) return null;
  const fm = await parseFrontmatter(join(skillDir, "SKILL.md"));
  return fm.version ?? null;
}

/**
 * amail skill install [--dir <path>]：复制包内 skills/ 下每个技能目录到目标目录。
 * 幂等：同名目标已存在先备份为 <name>.bak.<ts>，再整目录覆盖安装。
 */
export async function runSkillInstall(options: SkillInstallOptions = {}): Promise<string[]> {
  const targetRoot = options.dir ?? defaultInstallDir(options.env);
  const skillsDir = packageSkillsDir();
  await mkdir(targetRoot, { recursive: true });
  const installed: string[] = [];
  for (const name of await packageSkillNames(skillsDir)) {
    const target = join(targetRoot, name);
    if (existsSync(target)) {
      const backup = join(targetRoot, `${name}.bak.${Date.now()}`);
      await rename(target, backup);
    }
    await rm(target, { recursive: true, force: true });
    await cp(join(skillsDir, name), target, { recursive: true });
    installed.push(name);
    console.log(`已安装技能：${name} → ${target}`);
  }
  return installed;
}

/** amail skill status：列包内每个技能的包版本与已装版本 */
export async function runSkillStatus(options: SkillInstallOptions = {}): Promise<SkillStatusEntry[]> {
  const targetRoot = options.dir ?? defaultInstallDir(options.env);
  const skillsDir = packageSkillsDir();
  const entries: SkillStatusEntry[] = [];
  for (const name of await packageSkillNames(skillsDir)) {
    const packageVersion = await readVersion(join(skillsDir, name));
    const installedDir = join(targetRoot, name);
    const installed = existsSync(installedDir);
    entries.push({
      name,
      packageVersion,
      installedVersion: installed ? await readVersion(installedDir) : null,
      installed,
    });
  }
  for (const e of entries) {
    const state = e.installed
      ? e.installedVersion === e.packageVersion
        ? `已安装 v${e.installedVersion}`
        : `已装 v${e.installedVersion ?? "?"} / 包 v${e.packageVersion ?? "?"}（可 amail skill install 更新）`
      : "未安装";
    console.log(`${e.name}: ${state}`);
  }
  return entries;
}

export default function register(program: Command): void {
  const skill = program
    .command("skill")
    .description("manage the amail agent skill (install into Claude Code user skills dir)");
  skill
    .command("install")
    .description("copy every bundled skill dir into --dir (default ~/.claude/skills); backs up existing as <name>.bak.<ts>")
    .option("--dir <path>", "target skills directory")
    .action(async (opts: { dir?: string }) => {
      await runSkillInstall(opts);
    });
  skill
    .command("status")
    .description("list bundled skills with installed vs package versions")
    .option("--dir <path>", "target skills directory")
    .action(async (opts: { dir?: string }) => {
      await runSkillStatus(opts);
    });
}

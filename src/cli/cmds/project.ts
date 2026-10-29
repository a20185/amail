import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { loadProjects } from "../../core/project.js";

export interface ProjectAddOptions {
  name?: string;
  repos: string[];
  archiveDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProjectAddResult {
  slug: string;
  path: string;
  repos: string[];
  archiveDir: string;
}

/** 当前 git root（无仓库抛错，提示显式 --repo） */
export function gitRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { env, cwd, encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim() : "";
  if (!out) throw new Error("not inside a git repo — pass --repo explicitly");
  return out;
}

/** project add <slug> [--name] [--repo path]… [--archive dir]：写 projects.d/<slug>.json */
export function projectAdd(slug: string, options: ProjectAddOptions): ProjectAddResult {
  const dirs = resolveDirs(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  const repos = options.repos.length > 0 ? options.repos : [gitRoot(options.env ?? process.env, cwd)];
  const archiveDir = options.archiveDir ?? join(repos[0]!, ".amail", "inbox");
  const record = {
    name: options.name ?? slug,
    repos,
    archiveDir,
  };
  const path = join(dirs.projectsDir, `${slug}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  console.log(`project ${slug} registered → ${path}`);
  console.log(`  repos: ${repos.join(", ")}`);
  console.log(`  archive: ${archiveDir}`);
  return { slug, path, repos, archiveDir };
}

export function projectList(env: NodeJS.ProcessEnv = process.env): void {
  const projects = loadProjects(resolveDirs(env));
  if (projects.length === 0) {
    console.log("no projects registered — run `amail project add <slug>`");
    return;
  }
  for (const p of projects) {
    console.log(`${p.slug}\t${p.name}\trepos=${p.repos.join(",")}\tarchive=${p.archiveDir}`);
  }
}

export default function register(program: Command): void {
  const project = program.command("project").description("project registration");

  project
    .command("add")
    .description("register a project (repos default to the current git root)")
    .argument("<slug>", "project slug")
    .option("--name <name>", "display name (defaults to slug)")
    .option("--repo <path>", "repo path (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .option("--archive <dir>", "archive dir (defaults to <primary-repo>/.amail/inbox)")
    .action(async (slug: string, opts: { name?: string; repo: string[]; archive?: string }) => {
      projectAdd(slug, { name: opts.name, repos: opts.repo, archiveDir: opts.archive });
    });

  project.command("list").description("list registered projects").action(() => projectList());
}

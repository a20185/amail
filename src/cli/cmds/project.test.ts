import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitRoot, projectAdd } from "../../cli/cmds/project.js";
import { resolveDirs } from "../../core/paths.js";
import { loadProjects, resolveProjectByCwd } from "../../core/project.js";
import { sandboxEnv } from "../testkit.js";

function initRepo(path: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(path, { recursive: true });
  execSync("git init -q", { cwd: path, env });
}

describe("gitRoot", () => {
  it("resolves the toplevel of the cwd repo", () => {
    const { home, env } = sandboxEnv();
    const repo = join(home, "repo");
    initRepo(repo, env);
    expect(realpathSync(gitRoot(env, repo))).toBe(realpathSync(repo));
  });
  it("throws outside a repo", () => {
    const { home, env } = sandboxEnv();
    expect(() => gitRoot(env, home)).toThrow(/pass --repo/);
  });
});

describe("projectAdd", () => {
  it("registers multi-repo project and archiveDir defaults to primary repo", () => {
    const { home, env } = sandboxEnv();
    const r1 = join(home, "r1");
    const r2 = join(home, "r2");
    initRepo(r1, env);
    initRepo(r2, env);
    const result = projectAdd("web", { name: "Web App", repos: [r1, r2], env });
    expect(existsSync(result.path)).toBe(true);

    const dirs = resolveDirs({ AMAIL_HOME: home });
    const projects = loadProjects(dirs);
    expect(projects).toEqual([
      {
        slug: "web",
        name: "Web App",
        repos: [r1, r2],
        archiveDir: join(r1, ".amail", "inbox"),
      },
    ]);

    // resolveProjectByCwd：realpath 全等命中两个仓，未命中其它目录
    expect(resolveProjectByCwd(dirs, r1)?.slug).toBe("web");
    expect(resolveProjectByCwd(dirs, r2)?.slug).toBe("web");
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveProjectByCwd(dirs, elsewhere)).toBeUndefined();
  });
  it("repos default to the current git root when none given", () => {
    const { home, env } = sandboxEnv();
    const repo = join(home, "solo");
    initRepo(repo, env);
    const result = projectAdd("solo", { repos: [], env, cwd: repo });
    expect(result.repos).toHaveLength(1);
    expect(realpathSync(result.repos[0]!)).toBe(realpathSync(repo));
    expect(result.archiveDir).toBe(join(result.repos[0], ".amail", "inbox"));
  });

  it("re-registering overwrites the same slug", () => {
    const { home, env } = sandboxEnv();
    projectAdd("p", { repos: [join(home, "a")], env });
    projectAdd("p", { repos: [join(home, "b")], env });
    const dirs = resolveDirs({ AMAIL_HOME: home });
    expect(loadProjects(dirs)).toHaveLength(1);
    expect(loadProjects(dirs)[0]!.repos).toEqual([join(home, "b")]);
  });

  it("projectList output includes slug and archiveDir", () => {
    const { home, env } = sandboxEnv();
    projectAdd("listable", { repos: [join(home, "x")], archiveDir: join(home, "arc"), env });
    const dirs = resolveDirs({ AMAIL_HOME: home });
    const written = readFileSync(join(dirs.projectsDir, "listable.json"), "utf8");
    expect(JSON.parse(written)).toEqual({
      name: "listable",
      repos: [join(home, "x")],
      archiveDir: join(home, "arc"),
    });
  });
});

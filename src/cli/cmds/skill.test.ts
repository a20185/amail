import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultInstallDir, packageSkillNames, parseFrontmatter, runSkillInstall, runSkillStatus } from "./skill.js";
const repoSkills = fileURLToPath(new URL("../../../skills", import.meta.url));
const targetDir = () => mkdtempSync(join(tmpdir(), "amail-skill-"));

describe("skills/amail/SKILL.md", () => {
  it("frontmatter 可解析：name=amail，version=0.1.0，description 含四场景", async () => {
    const fm = await parseFrontmatter(join(repoSkills, "amail", "SKILL.md"));
    expect(fm.name).toBe("amail");
    expect(fm.version).toBe("0.1.0");
    expect(fm.description?.length ?? 0).toBeGreaterThan(0);
    expect(fm.description!.length).toBeLessThanOrEqual(200);
    for (const kw of ["看信", "回信", "发信", "handoff"]) {
      expect(fm.description).toContain(kw);
    }
    const body = readFileSync(join(repoSkills, "amail", "SKILL.md"), "utf8");
    for (const kw of ["流程一", "流程二", "流程三", "流程四", "命令速查", "护栏"]) {
      expect(body).toContain(kw);
    }
  });
});

describe("skills/amail-ws/SKILL.md", () => {
  it("frontmatter 可解析：name=amail-ws，version=0.1.0；正文覆盖工作区操作面与护栏", async () => {
    const fm = await parseFrontmatter(join(repoSkills, "amail-ws", "SKILL.md"));
    expect(fm.name).toBe("amail-ws");
    expect(fm.version).toBe("0.1.0");
    expect(fm.description?.length ?? 0).toBeGreaterThan(0);
    expect(fm.description!.length).toBeLessThanOrEqual(200);
    for (const kw of ["工作区", "artifact", "attach"]) expect(fm.description).toContain(kw);
    const body = readFileSync(join(repoSkills, "amail-ws", "SKILL.md"), "utf8");
    for (const kw of ["只读镜像", "事件即审计", "amail artifact", "amail attach", "护栏"]) {
      expect(body).toContain(kw);
    }
  });
});

describe("amail skill install", () => {
  it("安装后沙箱出现两个技能目录（amail + amail-ws）", async () => {
    const dir = targetDir();
    const installed = await runSkillInstall({ dir });
    expect(installed).toEqual(["amail", "amail-ws"]);
    expect((await readdir(dir)).filter((n) => !n.includes(".bak.")).sort()).toEqual(["amail", "amail-ws"]);
    expect(readFileSync(join(dir, "amail-ws", "SKILL.md"), "utf8")).toContain("name: amail-ws");
  });

  it("扫包内每个技能目录整目录复制到 --dir", async () => {
    const dir = targetDir();
    const installed = await runSkillInstall({ dir });
    expect(existsSync(join(dir, "amail", "SKILL.md"))).toBe(true);
    expect(installed).toEqual(await packageSkillNames(repoSkills));
  });

  it("幂等：目标存在先备份 <name>.bak.<ts> 再安装", async () => {
    const dir = targetDir();
    await runSkillInstall({ dir });
    writeFileSync(join(dir, "amail", "SKILL.md"), "---\nname: amail\nversion: 0.0.1\n---\nold\n", "utf8");
    await runSkillInstall({ dir });
    const amail = (await runSkillStatus({ dir })).find((e) => e.name === "amail");
    expect(amail?.installed).toBe(true);
    expect(amail?.installedVersion).toBe("0.1.0");
    const names = await readdir(dir);
    expect(names.some((n) => /^amail\.bak\.\d+$/.test(n))).toBe(true);
  });

  it("status：未安装目录 → installed=false", async () => {
    const entries = await runSkillStatus({ dir: targetDir() });
    expect(entries.find((e) => e.name === "amail")?.installed).toBe(false);
  });

  it("defaultInstallDir：AMAIL_SKILLS_DIR 覆盖 ~/.claude/skills", () => {
    expect(defaultInstallDir({ AMAIL_SKILLS_DIR: "/tmp/x" } as NodeJS.ProcessEnv)).toBe("/tmp/x");
    expect(defaultInstallDir({} as NodeJS.ProcessEnv)).toContain(join(".claude", "skills"));
  });

  it("扫描为纯目录扫描：P8 新增第二个技能目录即自动进入安装面", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "amail-skills-"));
    for (const [name, version] of [["amail", "0.1.0"], ["future-skill", "0.2.0"]] as const) {
      mkdirSync(join(skillsRoot, name));
      writeFileSync(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\nversion: ${version}\n---\n`, "utf8");
    }
    expect(await packageSkillNames(skillsRoot)).toEqual(["amail", "future-skill"]);
  });
});

#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";

export interface CmdModule {
  default: (program: Command) => void;
}

/** 子命令发现基准：main 模块兄弟 cmds/ 目录 */
export function defaultCmdsDir(): string {
  return fileURLToPath(new URL("./cmds", import.meta.url));
}

/**
 * 子命令自动发现：加载 dir（默认兄弟 cmds/）下全部命令模块。
 * 模块契约：default export register(program)。测试可注入目录，不依赖构建产物。
 */
export async function loadCmds(program: Command, dir: string = defaultCmdsDir()): Promise<string[]> {
  const entries = await readdir(dir);
  const files = entries
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !f.includes(".test."))
    .sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as CmdModule;
    if (typeof mod.default !== "function") {
      throw new Error(`cmd module ${file} must default-export register(program)`);
    }
    mod.default(program);
  }
  return files.map((f) => f.replace(/\.(ts|js)$/, ""));
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  program
    .name("amail")
    .description("LAN peer-to-peer mailbox + shared workspace")
    .version("0.0.1");
  await loadCmds(program);
  await program.parseAsync(argv);
  return 0;
}

/**
 * 入口判定。npm 全局安装把 bin 做成指向 dist/cli/main.js 的符号链接：
 * argv[1] 是链接路径，import.meta.url 是真实路径，直接比较会漏掉入口。
 * 两侧 realpath 后比较。
 */
export function isMainEntry(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

const isEntry = isMainEntry(process.argv[1], import.meta.url);
if (isEntry) {
  main().catch((err: NodeJS.ErrnoException & { exitCode?: number }) => {
    console.error(`amail: ${err.message}`);
    process.exit(err.exitCode ?? 1);
  });
}

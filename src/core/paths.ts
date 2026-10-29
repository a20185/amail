import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Dirs {
  home: string;
  configDir: string;
  dataDir: string;
  projectsDir: string;
  storePath: string;
  attachmentsDir: string;
  keysDir: string;
  peersDir: string;
}

export type PathEnv = { AMAIL_HOME?: string; HOME?: string };

/**
 * 共享契约·路径：
 * - AMAIL_HOME 设置 → 沙箱模式，全部落 $AMAIL_HOME/{config,data}
 * - 否则 ~/.config 存在 → XDG：配置 ~/.config/amail、数据 ~/.local/share/amail
 * - 否则统一 ~/.amail/
 * 所有目录自动创建（0700）。
 */
export function resolveDirs(env: PathEnv = process.env): Dirs {
  const home = env.AMAIL_HOME ?? env.HOME;
  if (!home) throw new Error("neither AMAIL_HOME nor HOME is set");

  let configDir: string;
  let dataDir: string;
  if (env.AMAIL_HOME) {
    configDir = join(env.AMAIL_HOME, "config");
    dataDir = join(env.AMAIL_HOME, "data");
  } else if (existsSync(join(home, ".config"))) {
    configDir = join(home, ".config", "amail");
    dataDir = join(home, ".local", "share", "amail");
  } else {
    configDir = join(home, ".amail");
    dataDir = join(home, ".amail");
  }

  const projectsDir = join(configDir, "projects.d");
  const storePath = join(dataDir, "store.db");
  const attachmentsDir = join(dataDir, "attachments");
  const keysDir = join(dataDir, "keys");
  const peersDir = join(dataDir, "peers");

  for (const dir of [configDir, dataDir, projectsDir, attachmentsDir, keysDir, peersDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  return {
    home,
    configDir,
    dataDir,
    projectsDir,
    storePath,
    attachmentsDir,
    keysDir,
    peersDir,
  };
}

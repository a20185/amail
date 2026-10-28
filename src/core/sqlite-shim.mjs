// 仅 vitest 用：vite5 的 builtin 清单不含 node:sqlite，直接 import 会被当作 npm 包解析失败。
// 生产构建（tsc）不走此文件，仍直接 import "node:sqlite"。
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export { DatabaseSync };

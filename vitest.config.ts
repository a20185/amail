import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // vite5 的 builtin 清单不含 node:sqlite；测试运行时经 createRequire shim 走真 node:sqlite
    alias: {
      "node:sqlite": fileURLToPath(new URL("./src/core/sqlite-shim.mjs", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

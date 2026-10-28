import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultRoutesDir, isLoopbackAddress, loadRoutes, matchRoute, normalizeRemoteAddress } from "./router.js";

const ROUTES_DIR = fileURLToPath(new URL("./routes", import.meta.url));

describe("route discovery", () => {
  it("默认目录 = router 模块兄弟 routes/", () => {
    expect(defaultRoutesDir()).toBe(ROUTES_DIR);
  });

  it("loadRoutes 注入 src/daemon/routes：发现 alive/inbox/send-local（不依赖构建产物）", async () => {
    const { routes, inits } = await loadRoutes(ROUTES_DIR);
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("GET /alive");
    expect(paths).toContain("GET /v1/inbox");
    expect(paths).toContain("POST /v1/send");
    expect(routes.find((r) => r.path === "/alive")?.lan).toBe(true);
    expect(routes.find((r) => r.path === "/v1/send")?.lan).toBe(false);
    // P4 起 deliver.ts 挂投递生命周期 init
    expect(inits).toHaveLength(1);
  });

  it("收集模块可选 init 并返回 disposer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amail-routes-"));
    writeFileSync(
      join(dir, "probe.ts"),
      `import type { Route } from "../../../../src/daemon/router.js";
let disposed = false;
export const isDisposed = () => disposed;
const r: Route = { method: "GET", path: "/probe", lan: true, handler: () => {} };
export default [r];
export const init = () => () => { disposed = true; };
`,
    );
    const { routes, inits } = await loadRoutes(dir);
    expect(routes).toHaveLength(1);
    expect(inits).toHaveLength(1);
    const mod = (await import(join(dir, "probe.ts"))) as { isDisposed: () => boolean };
    const disposer = inits[0]!({} as never);
    expect(mod.isDisposed()).toBe(false);
    (disposer as () => void)();
    expect(mod.isDisposed()).toBe(true);
  });

  it("非 Route[] 默认导出的模块被拒绝", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amail-routes-"));
    writeFileSync(join(dir, "bad.ts"), "export default 42;\n");
    await expect(loadRoutes(dir)).rejects.toThrow(/must default-export Route\[\]/);
  });
});

describe("matchRoute", () => {
  const routes = [
    { method: "GET" as const, path: "/v1/message/:id", lan: false, handler: () => {} },
    { method: "POST" as const, path: "/v1/read", lan: false, handler: () => {} },
  ];

  it(":param 捕获", () => {
    const m = matchRoute(routes, "GET", "/v1/message/msg_abc");
    expect(m?.params).toEqual({ id: "msg_abc" });
  });

  it("方法不匹配 / 路径不匹配 → undefined", () => {
    expect(matchRoute(routes, "POST", "/v1/message/msg_abc")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/v1/read")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/v1/nope")).toBeUndefined();
  });
});

describe("loopback 判定（规范化）", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", undefined])(
    "%s 放行",
    (addr) => {
      expect(isLoopbackAddress(addr)).toBe(true);
    },
  );
  it.each(["192.168.1.5", "10.0.0.2", "::ffff:192.168.1.5", "fe80::1"])("%s 拒绝", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
  it("v4-mapped 归一化", () => {
    expect(normalizeRemoteAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress("::1")).toBe("::1");
  });
});

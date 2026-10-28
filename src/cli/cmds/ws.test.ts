import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { fileURLToPath } from "node:url";
import { openStore } from "../../core/db.js";
import { listInbox } from "../../core/store.js";
import { startDaemon, userAddress, type DaemonHandle } from "../../daemon/server.js";
import {
  runWsAccept,
  runWsAction,
  runWsCreate,
  runWsExport,
  runWsList,
  runWsState,
  runWsTodoAdd,
  runWsTodoSet,
} from "./ws.js";

const ROUTES_DIR = fileURLToPath(new URL("../../daemon/routes", import.meta.url));

const handles: DaemonHandle[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
});

function sandbox(tag: string): { dirs: Dirs; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), tag));
  homes.push(home);
  const dirs = resolveDirs({ AMAIL_HOME: home });
  writeFileSync(
    join(dirs.projectsDir, "proj.json"),
    JSON.stringify({ name: "Proj", repos: [home], archiveDir: join(home, "archive") }),
    "utf8",
  );
  return { dirs, env: { ...process.env, AMAIL_HOME: home } };
}

async function withDaemon(dirs: Dirs): Promise<DaemonHandle> {
  const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR });
  handles.push(handle);
  writeFileSync(
    join(dirs.configDir, "config.json"),
    JSON.stringify({ version: 1, name: "Alice", email: "a@x.com", port: handle.port, notify: false }),
    "utf8",
  );
  return handle;
}

describe("ws CLI", () => {
  it("create：建区单事务（行+房主 membership seq=1）；list 显示 host 角色", async () => {
    const { dirs, env } = sandbox("cli-create-");
    await withDaemon(dirs);
    const id = runWsCreate({ project: "proj", name: "MyWs", env });
    expect(id).toMatch(/^ws_/);
    runWsList(env);
    const db = openStore(dirs.storePath);
    const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as { host_addr: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.host_addr).toContain("@");
  });

  it("create 未登记项目 → 报错", () => {
    const { env } = sandbox("cli-noproj-");
    expect(() => runWsCreate({ project: "nope", env })).toThrow(/unknown project/);
  });

  it("action/todo/state/export：本机（房主）闭环", async () => {
    const { dirs, env } = sandbox("cli-loop-");
    const handle = await withDaemon(dirs);
    const id = runWsCreate({ project: "proj", env });

    const action = await runWsAction({ who: handle.address, content: "did the thing", cc: [userAddress(handle.dirs, handle.identity)], env });
    expect(action.seq).toBe(2);

    const add = await runWsTodoAdd("write tests", { priority: 1, env });
    expect(add.seq).toBe(3);
    const stateAfterAdd = await runWsState({ kind: "todos", env });
    const todoId = stateAfterAdd.todos[0]!.id;
    const set = await runWsTodoSet(todoId, { status: "doing", env });
    expect(set.seq).toBe(4);

    const state = await runWsState({ env });
    expect(state.actions).toHaveLength(1);
    expect(state.todos[0]!.status).toBe("doing");
    expect(state.members).toEqual([userAddress(handle.dirs, handle.identity)]);
    const msgs = listInbox(handle.db, {});
    expect(msgs.some((m) => m.subject.startsWith(`[ws:${id.slice(0, 8)}]`))).toBe(true);

    const outDir = join(dirs.home, "export");
    const paths = await runWsExport({ out: outDir, env });
    expect(paths).toHaveLength(3);
    expect(existsSync(join(outDir, "Actions.md"))).toBe(true);
    const backlog = readFileSync(join(outDir, "Backlog.md"), "utf8");
    expect(backlog).toContain("write tests");
  });

  it("accept --file：从邀请块文件入区（daemon 不可达 host 时报错）", async () => {
    const { dirs, env } = sandbox("cli-accept-");
    const file = join(dirs.home, "invite.json");
    writeFileSync(file, JSON.stringify({ workspaceId: "ws_x", name: "x", hostAddr: "z@z", hostDeviceId: "d", sig: "s" }), "utf8");
    await expect(runWsAccept({ file, env })).rejects.toThrow(/not paired|unreachable/);
  });

  it("缺省工作区解析：零个报错；多个要求 --ws", async () => {
    const { dirs, env } = sandbox("cli-resolve-");
    const handle = await withDaemon(dirs);
    await expect(runWsState({ env })).rejects.toThrow(/no workspaces/);
    runWsCreate({ project: "proj", env });
    runWsCreate({ project: "proj", env });
    await expect(runWsAction({ who: handle.address, content: "x", cc: [], env })).rejects.toThrow(/multiple workspaces/);
  });
});

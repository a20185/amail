import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { showInbox } from "../../cli/cmds/inbox.js";
import { archiveMessage } from "../../cli/cmds/archive.js";
import { projectAdd } from "./project.js";
import { sandboxEnv, seedInbound, startStub, writeConfig } from "../testkit.js";
import type { DaemonHandle } from "../../daemon/server.js";
import type { Dirs } from "../../core/paths.js";

let stub: { handle: DaemonHandle; dirs: Dirs } | undefined;
afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("showInbox", () => {
  it("lists unarchived messages by default; --unread filters", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id1 = seedInbound(stub.handle.db, { body: "first message" });
    seedInbound(stub.handle.db, { body: "second message" });

    const items = await showInbox({ env });
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.id === id1)).toBe(true);

    const unread = await showInbox({ unread: true, env });
    expect(unread).toHaveLength(2);
  });

  it("--project view merges unarchived + that project's archived items", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const idKept = seedInbound(stub.handle.db, { body: "kept in inbox" });
    const idArchived = seedInbound(stub.handle.db, { body: "archived into project" });

    const repo = join(home, "repo");
    mkdirSync(repo);
    const archiveDir = join(home, "arc");
    projectAdd("web", { repos: [repo], archiveDir, env });
    await archiveMessage(idArchived, "web", env);

    // 显式 --project：未归档 + 该项目归档件
    const projectView = await showInbox({ project: "web", env });
    expect(projectView.map((i) => i.id).sort()).toEqual([idKept, idArchived].sort());

    // 默认视图（cwd 不在任何项目 repo 内）：只有未归档
    const defaultView = await showInbox({ env, cwd: home });
    expect(defaultView.map((i) => i.id)).toEqual([idKept]);
  });
  it("cwd-based project resolution picks up the registered repo", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const repo = join(home, "repo");
    mkdirSync(repo);
    const id = seedInbound(stub.handle.db, { body: "for cwd project" });
    projectAdd("cwdproj", { repos: [repo], env });
    await archiveMessage(id, "cwdproj", env);

    const items = await showInbox({ cwd: repo, env });
    expect(items.map((i) => i.id)).toEqual([id]);
  });

  it("fails with a clear error when the daemon is down", async () => {
    const { home, env } = sandboxEnv();
    writeConfig(home, 1); // 显式用关闭端口：避免本机真 daemon 干扰
    await expect(showInbox({ env })).rejects.toThrow(/daemon unreachable/);
  });
});

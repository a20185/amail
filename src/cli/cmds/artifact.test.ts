import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { sha256Hex } from "../../core/crypto.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server.js";
import { fakeMdns } from "../../daemon/e2e-kit.js";
import { runWsCreate } from "./ws.js";
import { mimeFor, runArtifactFetch, runArtifactList, runArtifactSubmit } from "./artifact.js";

const ROUTES_DIR = fileURLToPath(new URL("../../daemon/routes", import.meta.url));
const handles: DaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
});

async function sandbox(tag: string): Promise<{ dirs: Dirs; env: NodeJS.ProcessEnv; home: string }> {
  const home = mkdtempSync(join(tmpdir(), tag));
  const dirs = resolveDirs({ AMAIL_HOME: home });
  writeFileSync(
    join(dirs.projectsDir, "proj.json"),
    JSON.stringify({ name: "Proj", repos: [home], archiveDir: join(home, "archive") }),
    "utf8",
  );
  const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
  handles.push(handle);
  writeFileSync(
    join(dirs.configDir, "config.json"),
    JSON.stringify({ version: 1, name: "Alice", email: "a@x.com", port: handle.port, notify: false }),
    "utf8",
  );
  return { dirs, env: { ...process.env, AMAIL_HOME: home }, home };
}

function workspaceIds(dirs: Dirs): string[] {
  const db = openStore(dirs.storePath);
  const rows = db.prepare("SELECT id FROM workspaces ORDER BY created_at").all() as unknown as { id: string }[];
  db.close();
  return rows.map((r) => r.id);
}

describe("artifact CLI", () => {
  it("submit → list → fetch 哈希校验 round-trip（房主回环）", async () => {
    const { env, home } = await sandbox("cli-artifact-");
    runWsCreate({ project: "proj", name: "Artifacts", env });

    const file = join(home, "report.md");
    const content = "# 报告\n\n工件内容\n";
    writeFileSync(file, content, "utf8");

    const submitted = await runArtifactSubmit(file, { note: "阶段报告", tags: ["p8", "report"], env });
    expect(submitted.artifactId).toMatch(/^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(submitted.seq).toBe(2);
    expect(submitted.duplicate).toBe(false);

    const listed = await runArtifactList({ env });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.payload).toMatchObject({
      artifactId: submitted.artifactId,
      name: "report.md",
      mime: "text/markdown",
      size: Buffer.byteLength(content),
      note: "阶段报告",
      tags: ["p8", "report"],
      sha256: sha256Hex(Buffer.from(content, "utf8")),
    });

    const out = join(home, "downloaded.md");
    const fetched = await runArtifactFetch(submitted.artifactId, { out, env });
    expect(fetched.sha256).toBe(sha256Hex(Buffer.from(content, "utf8")));
    expect(readFileSync(out, "utf8")).toBe(content);
  });

  it("缺省工作区解析同 ws 命令；未知工件与超限文件报错", async () => {
    const { dirs, env, home } = await sandbox("cli-artifact-err-");
    const file = join(home, "a.txt");
    writeFileSync(file, "a", "utf8");

    await expect(runArtifactSubmit(file, { env })).rejects.toThrow(/no workspaces/);

    runWsCreate({ project: "proj", name: "One", env });
    const first = await runArtifactSubmit(file, { env });

    runWsCreate({ project: "proj", name: "Two", env });
    await expect(runArtifactSubmit(file, { env })).rejects.toThrow(/multiple workspaces/);
    await expect(runArtifactList({ env })).rejects.toThrow(/multiple workspaces/);

    const ids = workspaceIds(dirs);
    expect(await runArtifactList({ env, ws: ids[0]! })).toHaveLength(1);
    await expect(runArtifactFetch(first.artifactId, { out: join(home, "x"), env, ws: ids[0]! })).resolves.toBeDefined();
    await expect(
      runArtifactFetch("art_00000000000000000000000000", { out: join(home, "x"), env, ws: ids[0]! }),
    ).rejects.toThrow(/unknown artifact/);

    const big = join(home, "big.bin");
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(runArtifactSubmit(big, { env, ws: ids[0]! })).rejects.toThrow(/too large/);
  });

  it("mimeFor 已知扩展名与兜底", () => {
    expect(mimeFor("a/b/report.md")).toBe("text/markdown");
    expect(mimeFor("x.PNG")).toBe("image/png");
    expect(mimeFor("x.unknownext")).toBe("application/octet-stream");
  });
});

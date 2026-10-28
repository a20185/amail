import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveMessage } from "../../cli/cmds/archive.js";
import { projectAdd } from "./project.js";
import { sandboxEnv, seedInbound, startStub } from "../testkit.js";
import { get } from "../../core/store.js";
import { sha256Hex } from "../../core/crypto.js";
import type { DaemonHandle } from "../../daemon/server.js";
import type { Dirs } from "../../core/paths.js";

let stub: { handle: DaemonHandle; dirs: Dirs } | undefined;
afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("archiveMessage", () => {
  it("exports md with envelope header + body + handoff, copies attachments, idempotent overwrite", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const archiveDir = join(home, "arc");
    projectAdd("web", { repos: [join(home, "repo")], archiveDir, env });

    const blobDir = join(home, "blobs");
    mkdirSync(blobDir);
    const blobBytes = Buffer.from("attachment-bytes");
    const blobPath = join(blobDir, "att.bin");
    writeFileSync(blobPath, blobBytes);

    const handoff = JSON.stringify({
      progress: "done",
      description: "phase 3 archive",
      questions: ["who reviews?"],
    });
    const id = seedInbound(stub.handle.db, {
      envelope: {
        subject: "Archive Golden",
        from: "alice@laptop",
        attachments: [
          { id: "att_1", name: "att.bin", sha256: sha256Hex(blobBytes), size: blobBytes.length },
        ],
      },
      body: "golden body line",
      handoffJson: handoff,
      attachments: [{ id: "att_1", blobPath }],
    });

    const result = await archiveMessage(id, "web", env);
    expect(result.path).toBe(join(archiveDir, `${id}.md`));
    expect(existsSync(result.path)).toBe(true);

    // golden：信封头 + 正文 + handoff + 附件
    const md = readFileSync(result.path, "utf8");
    expect(md).toContain("# Archive Golden");
    expect(md).toContain(`- id: ${id}`);
    expect(md).toContain("- from: alice@laptop");
    expect(md).toContain('"progress":"done"');
    expect(md).toContain("## Handoff");
    expect(md).toContain(`- att.bin (${blobBytes.length}B, sha256=${sha256Hex(blobBytes)})`);
    expect(existsSync(join(archiveDir, "attachments", id, "att.bin"))).toBe(true);

    expect(get(stub.handle.db, id)?.archived_at).not.toBeNull();
    expect(get(stub.handle.db, id)?.project).toBe("web");

    // 幂等覆盖同名 id
    const again = await archiveMessage(id, "web", env);
    expect(again.path).toBe(result.path);
  });

  it("unknown project rejects with unknown-project", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id = seedInbound(stub.handle.db, { body: "x" });
    await expect(archiveMessage(id, "ghost", env)).rejects.toThrow(/unknown-project/);
  });
});

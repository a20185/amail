import { afterEach, describe, expect, it } from "vitest";
import { readMessage } from "../../cli/cmds/read.js";
import { sandboxEnv, seedInbound, startStub } from "../testkit.js";
import { get } from "../../core/store.js";
import type { DaemonHandle } from "../../daemon/server.js";
import type { Dirs } from "../../core/paths.js";

let stub: { handle: DaemonHandle; dirs: Dirs } | undefined;
afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("readMessage", () => {
  it("prints body/handoff/attachments and marks read", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const handoff = JSON.stringify({
      progress: "half done",
      description: "impl phase 3",
      questions: ["what next?"],
    });
    const id = seedInbound(stub.handle.db, { body: "read me", handoffJson: handoff });

    const message = await readMessage(id, { env });
    expect(message.body).toBe("read me");
    expect(message.handoff).toEqual(JSON.parse(handoff));
    expect(get(stub.handle.db, id)?.read_at).not.toBeNull();
  });

  it("--keep-unread leaves read_at null (no /v1/read call)", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id = seedInbound(stub.handle.db, { body: "stay unread" });

    await readMessage(id, { keepUnread: true, env });
    expect(get(stub.handle.db, id)?.read_at).toBeNull();
  });

  it("second read does not re-mark (daemon first-time gate keeps receipts single)", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id = seedInbound(stub.handle.db, { body: "twice" });

    await readMessage(id, { env });
    await readMessage(id, { env });
    const row = get(stub.handle.db, id);
    expect(row?.read_at).not.toBeNull();
  });

  it("unknown id rejects with daemon 404", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    await expect(readMessage("msg_nonexistent0000000000000000", { env })).rejects.toThrow(/404/);
  });
});

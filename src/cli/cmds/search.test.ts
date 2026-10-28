import { afterEach, describe, expect, it } from "vitest";
import { searchMessages } from "../../cli/cmds/search.js";
import { sandboxEnv, seedInbound, startStub } from "../testkit.js";
import type { DaemonHandle } from "../../daemon/server.js";
import type { Dirs } from "../../core/paths.js";

let stub: { handle: DaemonHandle; dirs: Dirs } | undefined;
afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("searchMessages", () => {
  it("finds messages by body keyword", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id = seedInbound(stub.handle.db, {
      body: "the xylophone concert is tonight",
      envelope: { subject: "concert" },
    });
    seedInbound(stub.handle.db, { body: "unrelated note" });

    const hits = await searchMessages("xylophone", env);
    expect(hits.map((h) => h.id)).toEqual([id]);
  });

  it("searches body text with trigram FTS", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const id = seedInbound(stub.handle.db, {
      body: "please review the trigram tokenizer",
      envelope: { subject: "review" },
    });
    const hits = await searchMessages("trigram tokenizer", env);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(id);
  });
});

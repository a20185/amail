import { afterEach, describe, expect, it } from "vitest";
import { watchEvents } from "../../cli/cmds/watch.js";
import { sandboxEnv, seedInbound, startStub } from "../testkit.js";
import { markRead } from "../../core/store.js";
import type { DaemonHandle } from "../../daemon/server.js";
import type { Dirs } from "../../core/paths.js";

let stub: { handle: DaemonHandle; dirs: Dirs } | undefined;
afterEach(async () => {
  await stub?.handle.stop();
  stub = undefined;
});

describe("watchEvents", () => {
  it("streams bus events over SSE until aborted", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);

    const ctrl = new AbortController();
    const watching = watchEvents({ env, signal: ctrl.signal });
    // SSE 连接建立是真实的网络往返——事件驱动测试无法替代这一段延迟
    await new Promise((resolve) => setTimeout(resolve, 150));
    const id = seedInbound(stub.handle.db, { body: "watched" });
    markRead(stub.handle.db, id);
    stub.handle.bus.emit("receipt", { messageId: id, kind: "read" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctrl.abort();

    const events = await watching;
    const receipt = events.find((e) => e.type === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt!.data).toEqual({ messageId: id, kind: "read" });
  });

  it("resolves empty on timeout without events", async () => {
    const { home, env } = sandboxEnv();
    stub = await startStub(home);
    const events = await watchEvents({ timeout: 0, env });
    expect(events).toEqual([]);
  });
});

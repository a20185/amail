import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawMirrorEvent } from "../contract/api.js";
import { opencodeAdapter } from "./opencode.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../tests/fixtures/mirror/opencode", import.meta.url));
const SESSION_ID = "ses_f5068ae9effeN1idpLZfsvJGU7";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("opencode adapter: 只读直读 db（fixture-first）", () => {
  it("discover：session 表 → SessionMeta（目录/标题/时间）", () => {
    const adapter = opencodeAdapter(FIXTURE_ROOT);
    const all = adapter.discover();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      sessionId: SESSION_ID,
      cli: "opencode",
      cwd: "/Users/souler/Documents/daqian/playground/testSkills",
      title: "从 r5clocal.env 同步 skill 并打包 zip",
      startedAt: new Date(1789652324707).toISOString(),
      mtime: new Date(1789653562724).toISOString(),
    });
  });

  it("stream：part 表 text → RawMirrorEvent（role 取所属 message；tool bash/step-* 忽略）", async () => {
    const adapter = opencodeAdapter(FIXTURE_ROOT);
    const controller = new AbortController();
    const events: RawMirrorEvent[] = [];
    const run = (async () => {
      for await (const ev of adapter.stream(SESSION_ID, controller.signal)) events.push(ev);
    })().catch(() => {});
    await waitFor(() => events.length >= 1);
    controller.abort();
    await run;
    expect(events[0]).toMatchObject({
      sessionId: SESSION_ID,
      role: "user",
      t: new Date(1789652324799).toISOString(),
    });
    expect(events[0]!.text).toContain("r5clocal.env");
    expect(events[0]).not.toHaveProperty("n");
    // 非 text/edit/write part 不产事件
    expect(events.every((ev) => typeof ev.text === "string" || ev.after !== undefined)).toBe(true);
  });

  it("db 不存在 → discover 空、stream 抛错", async () => {
    const adapter = opencodeAdapter(join(FIXTURE_ROOT, "nope"));
    expect(adapter.discover()).toEqual([]);
    const iterator = adapter.stream(SESSION_ID)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/not found/);
  });
});

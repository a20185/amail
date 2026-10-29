import { appendFileSync, cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawMirrorEvent } from "../contract/api.js";
import { piAdapter } from "./pi.js";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/mirror/pi", import.meta.url));
const SESSION_ID = "019fcd2b-50ba-7320-b271-076c989fdc76";

function copyFixture(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "amail-pi-"));
  cpSync(FIXTURE, root, { recursive: true });
  const slugDir = readdirSync(root)[0]!;
  const file = join(root, slugDir, readdirSync(join(root, slugDir))[0]!);
  return { root, file };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("pi adapter: discover", () => {
  it("按 <时间戳>_<uuid>.jsonl 列出会话（sessionId = uuid；cwd 取首行 session 元数据）", () => {
    const { root } = copyFixture();
    const adapter = piAdapter(root);
    const all = adapter.discover();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      sessionId: SESSION_ID,
      cli: "pi",
      cwd: "/private/tmp",
      startedAt: "2026-08-04T14:26:35.834Z",
    });
  });
});

describe("pi adapter: 增量尾随", () => {
  it("fixture 存量产出 user 文本事件（RawMirrorEvent，无 n）", async () => {
    const { root } = copyFixture();
    const adapter = piAdapter(root);
    const controller = new AbortController();
    const events: RawMirrorEvent[] = [];
    const run = (async () => {
      for await (const ev of adapter.stream(SESSION_ID, controller.signal)) events.push(ev);
    })().catch(() => {});
    await waitFor(() => events.length >= 1);
    controller.abort();
    await run;
    expect(events[0]).toEqual({ t: "2026-08-04T14:26:36.046Z", sessionId: SESSION_ID, role: "user", text: "hi" });
    expect(events[0]).not.toHaveProperty("n");
  });

  it("fixture 追加一条 message 行 → 2s 内产出事件", async () => {
    const { root, file } = copyFixture();
    const adapter = piAdapter(root);
    const controller = new AbortController();
    const events: RawMirrorEvent[] = [];
    const run = (async () => {
      for await (const ev of adapter.stream(SESSION_ID, controller.signal)) events.push(ev);
    })().catch(() => {});
    await waitFor(() => events.length >= 1);

    const line = {
      type: "message",
      id: "fixture-live",
      parentId: null,
      timestamp: "2026-08-04T14:30:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "live reply" }] },
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    await waitFor(() => events.length >= 2);
    expect(events[1]).toEqual({ t: "2026-08-04T14:30:00.000Z", sessionId: SESSION_ID, role: "assistant", text: "live reply" });
    controller.abort();
    await run;
  });
});

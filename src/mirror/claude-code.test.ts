import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawMirrorEvent } from "../contract/api.js";
import { ccSlug, ccUnslug, claudeCodeAdapter, claudeLineEvents } from "./claude-code.js";
import { MirrorAdapter } from "./types.js";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/mirror/claude-code", import.meta.url));

function copyFixture(): { root: string; file: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "amail-cc-"));
  cpSync(FIXTURE, root, { recursive: true });
  const slugDir = readdirSync(join(root, "projects"))[0]!;
  const file = join(root, "projects", slugDir, readdirSync(join(root, "projects", slugDir))[0]!);
  return { root, file, sessionId: file.split("/").pop()!.replace(/\.jsonl$/, "") };
}

function fixtureLines(): string[] {
  return readFileSync(join(FIXTURE, `projects/${readdirSync(join(FIXTURE, "projects"))[0]}/${readdirSync(join(FIXTURE, "projects", readdirSync(join(FIXTURE, "projects"))[0]!))[0]}`), "utf8")
    .trim()
    .split("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("claude-code adapter: slug / discover", () => {
  it("cwd 绝对路径 / → -（/Users/souler/Test → -Users-souler-Test）且可逆", () => {
    expect(ccSlug("/Users/souler/Test")).toBe("-Users-souler-Test");
    expect(ccUnslug("-Users-souler-Test")).toBe("/Users/souler/Test");
  });

  it("discover 按 cwd slug 列出 fixture 会话元信息", () => {
    const { root, sessionId } = copyFixture();
    const adapter = claudeCodeAdapter(root);
    const all = adapter.discover();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      sessionId,
      cli: "claude-code",
      cwd: "/Users/souler/Test",
      title: "[Request interrupted by user]",
      startedAt: "2026-09-04T03:34:17.460Z",
    });
    expect(adapter.discover("/Users/souler/Test").map((s) => s.sessionId)).toEqual([sessionId]);
    expect(adapter.discover("/elsewhere")).toEqual([]);
  });
});

describe("claude-code adapter: 行 → RawMirrorEvent 映射", () => {
  it("text → msg；Edit/Write/NotebookEdit 三类工具按工具分列映射", () => {
    const lines = fixtureLines();
    const [sessionId] = readdirSync(join(FIXTURE, "projects", readdirSync(join(FIXTURE, "projects"))[0]!))
      .map((f) => f.replace(/\.jsonl$/, ""));

    const msg = claudeLineEvents(sessionId!, lines[0]!);
    expect(msg).toEqual([
      { t: "2026-09-04T03:34:17.460Z", sessionId, role: "user", text: "[Request interrupted by user]" },
    ]);

    const edit = claudeLineEvents(sessionId!, lines[1]!);
    expect(edit).toHaveLength(1);
    expect(edit[0]).toMatchObject({
      sessionId,
      path: "/Users/souler/Test/inference-rules-v3.md",
      before: "### 0.4 过家家自检（输出前最后一道）",
    });
    expect(edit[0]!.after).toContain("### 0.5 绝境域检测");
    expect(edit[0]!.text).toBeUndefined();

    const write = claudeLineEvents(sessionId!, lines[2]!);
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({ path: "/Users/souler/Test/ts6-structural-analysis-v2.md" });
    expect(write[0]!.after).toContain("# TS6 盲测结构性问题分析");
    expect(write[0]!.before).toBeUndefined();

    const notebook = claudeLineEvents(sessionId!, lines[3]!);
    expect(notebook).toHaveLength(1);
    expect(notebook[0]).toEqual({
      t: "2026-09-09T10:00:00.000Z",
      sessionId,
      path: "/Users/souler/Test/analysis.ipynb",
      after: "print('hello notebook')",
    });
    expect(notebook[0]!.before).toBeUndefined();
  });

  it("非 JSON / 非 message 行忽略", () => {
    expect(claudeLineEvents("s", "not json")).toEqual([]);
    expect(claudeLineEvents("s", JSON.stringify({ type: "queue-operation" }))).toEqual([]);
  });
});

describe("claude-code adapter: 增量尾随", () => {
  it("fixture 存量产出 4 条 RawMirrorEvent（无 n 序号）", async () => {
    const { root, sessionId } = copyFixture();
    const adapter: MirrorAdapter = claudeCodeAdapter(root);
    const controller = new AbortController();
    const events: RawMirrorEvent[] = [];
    const run = (async () => {
      for await (const ev of adapter.stream(sessionId, controller.signal)) events.push(ev);
    })().catch(() => {});
    await waitFor(() => events.length >= 4);
    controller.abort();
    await run;
    expect(events.map((e) => e.sessionId)).toEqual(Array(4).fill(sessionId));
    expect(events[1]!.path).toContain("inference-rules-v3.md");
    expect(events[3]!.path).toContain("analysis.ipynb");
    for (const ev of events) expect(ev).not.toHaveProperty("n");
  });

  it("fixture 追加一行 → 2s 内产出对应事件（watch + 500ms 轮询兜底）", async () => {
    const { root, file, sessionId } = copyFixture();
    const adapter = claudeCodeAdapter(root);
    const controller = new AbortController();
    const events: RawMirrorEvent[] = [];
    const run = (async () => {
      for await (const ev of adapter.stream(sessionId, controller.signal)) events.push(ev);
    })().catch(() => {});
    await waitFor(() => events.length >= 4);

    const appended = {
      cwd: "/Users/souler/Test",
      sessionId,
      timestamp: "2026-09-09T11:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/live.md", old_string: "a", new_string: "b" } }],
      },
    };
    appendFileSync(file, `${JSON.stringify(appended)}\n`);
    const started = Date.now();
    await waitFor(() => events.length >= 5);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events[4]).toEqual({
      t: "2026-09-09T11:00:00.000Z",
      sessionId,
      path: "/tmp/live.md",
      before: "a",
      after: "b",
    });
    controller.abort();
    await run;
  });

  it("未知 session → stream 抛错", async () => {
    const { root } = copyFixture();
    const adapter = claudeCodeAdapter(root);
    const iterator = adapter.stream("nope")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/session not found/);
  });
});

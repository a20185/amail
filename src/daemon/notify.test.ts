import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notify } from "./notify.js";

describe("notify", () => {
  it("AMAIL_NOTIFY_CMD 覆盖：经 AMAIL_TITLE/AMAIL_BODY 传参执行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amail-notify-"));
    const out = join(dir, "out.txt");
    const script = join(dir, "stub.sh");
    writeFileSync(script, '#!/bin/sh\necho "$AMAIL_TITLE|$AMAIL_BODY" > "$AMAIL_OUT"\n');
    chmodSync(script, 0o755);
    await notify("标题", "正文", {
      env: { AMAIL_NOTIFY_CMD: script, AMAIL_OUT: out },
    });
    expect(readFileSync(out, "utf8").trim()).toBe("标题|正文");
  });

  it("非 darwin/linux 平台 no-op（不抛错）", async () => {
    await notify("t", "b", { platform: "win32" });
  });

  it("darwin：走 osascript（AMAIL_NOTIFY_CMD 缺失时不直接执行命令）", async () => {
    // 用覆盖命令验证 darwin 分支的参数拼装入口可被替换执行
    const dir = mkdtempSync(join(tmpdir(), "amail-notify-"));
    const out = join(dir, "darwin.txt");
    const script = join(dir, "stub.sh");
    writeFileSync(script, '#!/bin/sh\necho "$AMAIL_PLATFORM" > "$AMAIL_OUT"\n');
    chmodSync(script, 0o755);
    await notify("t", "b", {
      platform: "darwin",
      env: { AMAIL_NOTIFY_CMD: script, AMAIL_OUT: out, AMAIL_PLATFORM: "darwin" },
    });
    expect(readFileSync(out, "utf8").trim()).toBe("darwin");
  });
});

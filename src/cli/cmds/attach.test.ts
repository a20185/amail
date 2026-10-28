import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs } from "../../core/paths.js";
import { openStore } from "../../core/db.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server.js";
import { runWsCreate } from "./ws.js";
import { listAttachable, runAttach, runDetach } from "./attach.js";

const ROUTES_DIR = fileURLToPath(new URL("../../daemon/routes", import.meta.url));
const CC_FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/mirror/claude-code", import.meta.url));
const SESSION_ID = "0b34d286-4903-4d93-be17-128b6b3d653e";

const handles: DaemonHandle[] = [];
const savedEnv = {
  cc: process.env.AMAIL_MIRROR_CC_ROOT,
  pi: process.env.AMAIL_MIRROR_PI_ROOT,
  oc: process.env.AMAIL_MIRROR_OC_ROOT,
};

afterEach(async () => {
  const restore = (key: string, saved: string | undefined) => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
  restore("AMAIL_MIRROR_CC_ROOT", savedEnv.cc);
  restore("AMAIL_MIRROR_PI_ROOT", savedEnv.pi);
  restore("AMAIL_MIRROR_OC_ROOT", savedEnv.oc);
  for (const handle of handles.splice(0)) await handle.stop();
});

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("attach CLI", () => {
  it("--list 列出本机会话；attach --session 直选 → detach", async () => {
    const root = mkdtempSync(join(tmpdir(), "amail-cli-mirror-"));
    cpSync(CC_FIXTURE, join(root, "cc"), { recursive: true });
    process.env.AMAIL_MIRROR_CC_ROOT = join(root, "cc");
    process.env.AMAIL_MIRROR_PI_ROOT = join(root, "no-pi");
    process.env.AMAIL_MIRROR_OC_ROOT = join(root, "no-oc");

    const home = join(root, "home");
    const dirs = resolveDirs({ AMAIL_HOME: home });
    writeFileSync(
      join(dirs.projectsDir, "proj.json"),
      JSON.stringify({ name: "Proj", repos: [root], archiveDir: join(root, "archive") }),
      "utf8",
    );

    const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR });
    handles.push(handle);
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify({ version: 1, name: "Alice", email: "a@x.com", port: handle.port, notify: false }),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { ...process.env, AMAIL_HOME: home };

    const wsId = runWsCreate({ project: "proj", name: "Mirror", env });

    const sessions = await listAttachable(env);
    expect(sessions.map((s) => `${s.cli}:${s.sessionId}`)).toEqual([`claude-code:${SESSION_ID}`]);

    // 过滤无匹配 → 报错并指向 --list
    await expect(runAttach({ cli: "pi", env })).rejects.toThrow(/no attachable session/);

    const outcome = await runAttach({ session: SESSION_ID, env });
    expect(outcome.attachEventId).toMatch(/^evt_/);
    expect(outcome.session.sessionId).toBe(SESSION_ID);

    const db = openStore(dirs.storePath);
    const kinds = () =>
      (
        db.prepare("SELECT event_json FROM workspace_events WHERE workspace_id = ? ORDER BY seq").all(wsId) as unknown as {
          event_json: string;
        }[]
      ).map((r) => (JSON.parse(r.event_json) as { kind: string }).kind);
    expect(await until(() => kinds().includes("session.attach"))).toBe(true);

    await runDetach(SESSION_ID, { env });
    expect(await until(() => kinds().includes("session.detach"))).toBe(true);
    expect(kinds().filter((k) => k === "session.attach")).toHaveLength(1);
    expect(kinds().filter((k) => k === "session.detach")).toHaveLength(1);
    db.close();
  }, 20_000);
});

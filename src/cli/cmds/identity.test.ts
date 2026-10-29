import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { showIdentity } from "../../cli/cmds/identity.js";
import { runSetup } from "../../cli/cmds/setup.js";
import { resolveDirs } from "../../core/paths.js";
import { sandboxEnv } from "../testkit.js";

describe("showIdentity", () => {
  it("shows mapped address, fingerprint and claim after setup", async () => {
    const { home, env } = sandboxEnv();
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Zhang San@Corp\n\temail = z@example.com\n");
    await runSetup({ yes: true, env, cwd: home });

    const info = showIdentity(env);
    expect(info.address).toBe(`zhang-sancorp@${info.address.split("@")[1]}`);
    expect(info.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(info.claim).toEqual({ name: "Zhang San@Corp", email: "z@example.com" });
  });

  it("works without prior setup (defaults)", () => {
    const { env } = sandboxEnv();
    const info = showIdentity(env);
    expect(info.address).toMatch(/^user@/);
    expect(info.claim).toBeUndefined();
  });

  it("identity is stable across runs (same seed)", async () => {
    const { env } = sandboxEnv();
    const first = showIdentity(env);
    const second = showIdentity(env);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.address).toBe(first.address);
    expect(resolveDirs(env).keysDir).toBeTruthy();
  });
});

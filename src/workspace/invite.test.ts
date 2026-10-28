import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { resolveDirs, type Dirs } from "../core/paths.js";
import { openStore } from "../core/db.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import { savePeer } from "../core/peer.js";
import { userAddress } from "../daemon/server.js";
import { parseAddress } from "../contract/address.js";
import { configureDelivery, resetDeliveryConfig } from "../core/delivery.js";
import { acceptInvite, buildInvite, type WorkspaceInvite } from "./invite.js";
import { isSyncing } from "./projection-local.js";

const servers: Server[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  for (const server of servers.splice(0)) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
});

interface FakeHost {
  server: Server;
  port: number;
}

/** 假房主：/join 返回指定状态码 */
async function fakeHost(status: number, error: string): Promise<FakeHost> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error }));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

interface Fixture {
  invite: WorkspaceInvite;
  memberDirs: Dirs;
  wsId: string;
}

/** 本机（成员）已与“房主”配对；房主可达地址指向假 HTTP 服务 */
async function fixture(tag: string, host: FakeHost): Promise<Fixture> {
  const hostDirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), `amail-inv-host-${tag}-`)) });
  const hostIdentity = loadOrCreateIdentity(hostDirs);
  const wsId = `ws_${ulid()}`;
  const invite = buildInvite({ dirs: hostDirs, identity: hostIdentity }, { id: wsId, name: "Proj" });

  const memberDirs = resolveDirs({ AMAIL_HOME: mkdtempSync(join(tmpdir(), `amail-inv-member-${tag}-`)) });
  const hostAddr = parseAddress(invite.hostAddr);
  const db = openStore(memberDirs.storePath);
  savePeer(db, {
    deviceId: hostIdentity.deviceId,
    deviceName: hostIdentity.deviceName,
    user: hostAddr.user,
    device: hostAddr.device,
    claim: { name: "Host", email: "host@example.com" },
    signPubKeyPem: hostIdentity.signPubPem,
    encPubKeyPem: hostIdentity.encPubPem,
    pairedAt: new Date().toISOString(),
    revokedAt: null,
  });
  db.close();

  configureDelivery({
    browse: async () => [
      {
        name: `amail-${hostIdentity.deviceId}`,
        host: "127.0.0.1",
        port: host.port,
        txt: { fp: hostIdentity.deviceId, user: userAddress(hostDirs, hostIdentity), ver: "test" },
      },
    ],
  });

  return { invite, memberDirs, wsId };
}

function workspaceCount(dirs: Dirs): number {
  const db = openStore(dirs.storePath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number };
  db.close();
  return row.n;
}

describe("acceptInvite: join 失败不留本地记录、不启动同步", () => {
  for (const [status, error] of [
    [401, "unauthorized"],
    [403, "not-a-member"],
  ] as const) {
    it(`房主 join ${status} → 抛错，workspaces 空，无 ws-sync 触发`, async () => {
      const host = await fakeHost(status, error);
      const { invite, memberDirs, wsId } = await fixture(String(status), host);

      const urls: string[] = [];
      const realFetch = globalThis.fetch;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        urls.push(String(input));
        return realFetch(input, init);
      });
      try {
        await expect(acceptInvite(memberDirs, invite)).rejects.toThrow(new RegExp(`join rejected.*${status}`));
      } finally {
        spy.mockRestore();
      }

      expect(workspaceCount(memberDirs)).toBe(0);
      expect(urls.some((url) => url.includes("/v1/ws-sync"))).toBe(false);
      expect(isSyncing(wsId)).toBe(false);
    });
  }
});

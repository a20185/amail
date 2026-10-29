import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";
import type { PeerRecord } from "../../contract/identity.js";

export interface ScanItem {
  name: string;
  host: string;
  port: number;
  fp: string;
  user: string;
}

export interface PeersOptions {
  scan?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** amail peers：列出已配对设备；--scan 经 mDNS 列出局域网可配对设备 */
export async function showPeers(options: PeersOptions = {}): Promise<PeerRecord[] | ScanItem[]> {
  const dirs = resolveDirs(options.env ?? process.env);
  if (options.scan) {
    const items = (await apiFetch(dirs, "/v1/peers/scan")) as ScanItem[];
    if (items.length === 0) console.log("（未发现局域网 amail 设备）");
    for (const item of items) {
      console.log(`${item.user}  fp=${item.fp}  ${item.host}:${item.port}  (${item.name})`);
    }
    return items;
  }
  const peers = (await apiFetch(dirs, "/v1/peers")) as PeerRecord[];
  if (peers.length === 0) console.log("（尚未配对任何设备，先 `amail pair <user@device>`）");
  for (const peer of peers) {
    const addr = `${peer.user}@${peer.device}`;
    const revoked = peer.revokedAt ? " [revoked]" : "";
    console.log(`${addr}  fp=${peer.deviceId}  ${peer.deviceName}${revoked}`);
  }
  return peers;
}

export default function register(program: Command): void {
  program
    .command("peers")
    .description("list paired peers; --scan to browse LAN devices via mDNS")
    .option("--scan", "browse LAN amail devices instead of paired list")
    .action(async (opts: { scan?: boolean }) => {
      await showPeers(opts);
    });
}

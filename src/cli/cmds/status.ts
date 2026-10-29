import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";

export interface StatusView {
  version: string;
  address: string;
  unread: number;
  outbox: { queued: number; delivered: number; expired: number };
  peers: number;
}

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
}

/** amail status：调 daemon GET /v1/status 概况 */
export async function showStatus(options: StatusOptions = {}): Promise<StatusView> {
  const dirs = resolveDirs(options.env ?? process.env);
  const status = (await apiFetch(dirs, "/v1/status")) as StatusView;
  console.log(`daemon ${status.version}  ${status.address}`);
  console.log(`未读 ${status.unread}  出箱 ${status.outbox.queued}排队/${status.outbox.delivered}已投/${status.outbox.expired}过期  已配对 ${status.peers}`);
  return status;
}

export default function register(program: Command): void {
  program
    .command("status")
    .description("daemon overview: unread / outbox / peers")
    .action(async () => {
      await showStatus();
    });
}

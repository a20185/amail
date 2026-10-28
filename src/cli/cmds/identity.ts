import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { fingerprint, loadOrCreateIdentity } from "../../core/identity.js";
import { UserClaimSchema, type UserClaim } from "../../contract/identity.js";
import { mapGitNameToUser } from "./setup.js";
import { readConfig } from "../util.js";

export interface IdentityInfo {
  address: string;
  fingerprint: string;
  claim: { name: string; email: string } | undefined;
}

/** 地址/声明/指纹一览 */
export function showIdentity(env: NodeJS.ProcessEnv = process.env): IdentityInfo {
  const dirs = resolveDirs(env);
  const identity = loadOrCreateIdentity(dirs);
  const config = readConfig(dirs);
  const claimPath = join(dirs.configDir, "claim.json");
  const claim: UserClaim | undefined = existsSync(claimPath)
    ? UserClaimSchema.parse(
        (JSON.parse(readFileSync(claimPath, "utf8")) as { claim: unknown }).claim,
      )
    : undefined;
  const name = config?.name ?? claim?.name ?? "user";
  const info: IdentityInfo = {
    address: `${mapGitNameToUser(name)}@${identity.deviceName}`,
    fingerprint: fingerprint(identity.signPubPem),
    claim,
  };
  console.log(`address:     ${info.address}`);
  console.log(`fingerprint: ${info.fingerprint}`);
  console.log(`deviceId:    ${identity.deviceId}`);
  console.log(`deviceName:  ${identity.deviceName}`);
  if (info.claim) console.log(`claim:       ${info.claim.name} <${info.claim.email}>`);
  return info;
}

export default function register(program: Command): void {
  program.command("identity").description("show address, claim and fingerprint").action(() => {
    showIdentity();
  });
}

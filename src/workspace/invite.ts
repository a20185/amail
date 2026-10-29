import { z } from "zod";
import { openStore } from "../core/db.js";
import type { Dirs } from "../core/paths.js";
import { loadOrCreateIdentity, type DeviceIdentityFull } from "../core/identity.js";
import { getPeerByAddress } from "../core/peer.js";
import { signCanonical, verifyCanonical } from "../core/crypto.js";
import { userAddress } from "../daemon/server.js";
import { canonicalStringify } from "../core/crypto.js";
import { AddressSchema } from "../contract/address.js";
import { apiFetch } from "../cli/util.js";
import {
  amailSigHeaders,
  deviceSignMessage,
  resolveHostBase,
} from "./projection-local.js";

export const InviteSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  hostAddr: AddressSchema,
  hostDeviceId: z.string().min(1),
  sig: z.string().min(1),
});
export type WorkspaceInvite = z.infer<typeof InviteSchema>;

export interface HostSigning {
  dirs: Dirs;
  identity: DeviceIdentityFull;
}

/** 房主签发邀请块：sig 覆盖 {workspaceId,name,hostAddr,hostDeviceId} */
export function buildInvite(
  signing: HostSigning,
  ws: { id: string; name: string },
): WorkspaceInvite {
  const base = {
    workspaceId: ws.id,
    name: ws.name,
    hostAddr: userAddress(signing.dirs, signing.identity),
    hostDeviceId: signing.identity.deviceId,
  };
  return { ...base, sig: signCanonical(signing.identity.signPrivPem, base) };
}

export function verifyInviteSig(pubPem: string, invite: WorkspaceInvite): boolean {
  const { sig, ...unsigned } = invite;
  try {
    return verifyCanonical(pubPem, unsigned, sig);
  } catch {
    return false;
  }
}

export interface AcceptResult {
  workspaceId: string;
  seq?: number;
  alreadyMember: boolean;
}

/**
 * 接受邀请（被邀请方本机执行）：
 * 1. 验邀请块签名（房主设备公钥取自 peers）
 * 2. 本地登记 workspace（hostAddr 指向房主）
 * 3. 调房主 POST /ws/:id/join 完成准入（房主代生成 membership add）
 * 4. 经回环 POST /v1/ws-sync/:id 触发 daemon 启动实时同步（CLI 不持有同步任务）
 */
export async function acceptInvite(dirs: Dirs, invite: WorkspaceInvite): Promise<AcceptResult> {
  const parsed = InviteSchema.safeParse(invite);
  if (!parsed.success) throw new Error(`invalid invite: ${parsed.error.message}`);
  const identity = loadOrCreateIdentity(dirs);
  const db = openStore(dirs.storePath);

  const peer = getPeerByAddress(db, invite.hostAddr);
  if (!peer) throw new Error(`host ${invite.hostAddr} is not paired — run \`amail pair\` first`);
  if (!verifyInviteSig(peer.signPubKeyPem, parsed.data)) {
    throw new Error("invite signature check failed");
  }

  // join：房主验双重签名 + 已配对 → 房主构造并签署 membership add 定序
  const actor = userAddress(dirs, identity);
  const base = await resolveHostBase(db, invite.hostAddr);
  if (!base) throw new Error(`host ${invite.hostAddr} unreachable`);
  const pathname = `/ws/${invite.workspaceId}/join`;
  const payload = {
    invite: parsed.data,
    actor,
    sig: deviceSignMessage(identity.signPrivPem, `${invite.workspaceId}${actor}`),
  };
  const bodyText = canonicalStringify(payload);
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(identity.signPrivPem, "POST", pathname, bodyText, actor),
    },
    body: bodyText,
  });

  const out = (await res.json().catch(() => ({}))) as { seq?: number; alreadyMember?: boolean; error?: string };
  // 先校验房主受理（失败不留本地记录、不启动同步）
  if (!res.ok) {
    throw new Error(`join rejected by host ${invite.hostAddr}: ${res.status} ${out.error ?? ""}`.trim());
  }

  // 本地登记 workspace（幂等；只在房主确认准入后落本地）
  db.prepare(
    `INSERT INTO workspaces (id, name, project_slug, host_addr, created_at)
     VALUES (?, ?, '', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(invite.workspaceId, invite.name, invite.hostAddr, new Date().toISOString());

  // 回环触发 daemon 内 ensureSync（幂等；daemon 运行中入区无需重启）
  await apiFetch(dirs, `/v1/ws-sync/${invite.workspaceId}`, { method: "POST" }).catch(() => {
    // daemon 未运行：init 批量恢复会在下次启动时补上
  });

  return { workspaceId: invite.workspaceId, seq: out.seq, alreadyMember: out.alreadyMember === true };
}

/** 从信件正文解析邀请块（正文即邀请 JSON） */
export function parseInviteFromText(text: string): WorkspaceInvite {
  return InviteSchema.parse(JSON.parse(text));
}

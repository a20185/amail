/**
 * 工作区工件（房主侧）：上传定位 → 字节落 blob → 签名事件定序。
 *
 * 上传方在 `X-Amail-Meta` 头携带已签名事件（与 host.submit 同形，kind=artifact）：
 * 事件签名先验（成员 + 公钥），随后流式落临时文件并对 **实际字节数 + sha256**
 * 与 meta 双校验；通过后在**单事务**内把 blob 分桶落位
 * （attachments/<前2位>/<hash>，去重复用）并直接调 host.submit 定序落库——
 * submit 不做 kind 限制，拒绝门只在通用 /events 路由层，此处无绕行路径。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DaemonCore } from "../daemon/router.js";
import type { ArtifactMeta } from "../contract/attachment.js";
import { getPeerByAddress } from "../core/peer.js";
import { getWorkspaceRow, WorkspaceHost, type SubmitResult } from "./host.js";
import { SubmitEventSchema, verifyEventSig, type SubmitEvent } from "./events.js";

/** 单文件上限（与 LAN 附件一致） */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type ArtifactUploadErrorCode =
  | "invalid-event"
  | "unknown-workspace"
  | "too-large"
  | "mismatch"
  | "not-member"
  | "bad-sig";

export class ArtifactUploadError extends Error {
  constructor(
    public readonly code: ArtifactUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactUploadError";
  }

  get status(): number {
    switch (this.code) {
      case "unknown-workspace":
        return 404;
      case "too-large":
        return 413;
      case "mismatch":
        return 422;
      case "not-member":
        return 403;
      case "bad-sig":
        return 401;
      default:
        return 400;
    }
  }
}

export interface UploadResult {
  seq: number;
  duplicate: boolean;
  artifactId: string;
}

/** 工件 blob 的分桶落位路径（sha256 前 2 位分桶，去重复用） */
export function blobPathFor(dirs: DaemonCore["dirs"], sha256: string): string {
  return join(dirs.attachmentsDir, sha256.slice(0, 2), sha256);
}

/**
 * `X-Amail-Meta` 头载荷 = base64url(JSON 事件)。
 * HTTP 头只接受可见 ASCII，note/tags 可含中文，故统一编码。
 */
export function encodeUploadMeta(event: SubmitEvent): string {
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
}

/** 解析 `X-Amail-Meta`（base64url JSON）；非法编码抛 invalid-event */
export function decodeUploadMeta(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ArtifactUploadError("invalid-event", "X-Amail-Meta is not base64url(JSON)");
  }
}

/** 房主侧验签：actor 须为成员，且事件签名可用其公钥验证（房主=本机身份，成员=peers） */
function verifyUploadEvent(core: DaemonCore, host: WorkspaceHost, event: SubmitEvent): void {
  if (!host.state().members.includes(event.actor)) {
    throw new ArtifactUploadError("not-member", `actor ${event.actor} is not a member`);
  }
  const pubPem =
    event.actor === host.hostAddr
      ? core.identity.signPubPem
      : getPeerByAddress(core.db, event.actor)?.signPubKeyPem;
  if (!pubPem) {
    throw new ArtifactUploadError("not-member", `actor ${event.actor} is not paired`);
  }
  if (!verifyEventSig(pubPem, event)) {
    throw new ArtifactUploadError("bad-sig", `signature check failed for ${event.actor}`);
  }
}

function parseArtifactEvent(signedEvent: unknown): SubmitEvent & { kind: "artifact"; payload: ArtifactMeta } {
  const parsed = SubmitEventSchema.safeParse(signedEvent);
  if (!parsed.success) {
    throw new ArtifactUploadError("invalid-event", `invalid event: ${parsed.error.message}`);
  }
  if (parsed.data.kind !== "artifact") {
    throw new ArtifactUploadError("invalid-event", `event kind must be artifact, got ${parsed.data.kind}`);
  }
  return parsed.data;
}

/**
 * 接收一次工件上传：验事件签名 → 流式落临时文件（实际字节数/哈希双校验）
 * → 单事务（blob 落位 + submit 定序）→ 广播。
 */
export async function receiveUpload(
  core: DaemonCore,
  workspaceId: string,
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  signedEvent: unknown,
): Promise<UploadResult> {
  const row = getWorkspaceRow(core.db, workspaceId);
  if (!row) throw new ArtifactUploadError("unknown-workspace", `unknown workspace: ${workspaceId}`);

  const event = parseArtifactEvent(signedEvent);
  const meta = event.payload;
  const host = new WorkspaceHost(core, workspaceId);
  verifyUploadEvent(core, host, event);

  if (meta.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactUploadError("too-large", `artifact too large: ${meta.size}`);
  }

  const tmpPath = join(core.dirs.dataDir, `.upload-${event.eventId}-${Date.now()}.tmp`);
  const hasher = createHash("sha256");
  let received = 0;
  let fd: number | undefined = openSync(tmpPath, "wx", 0o600);
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_ARTIFACT_BYTES) {
        throw new ArtifactUploadError("too-large", `artifact too large: >${MAX_ARTIFACT_BYTES}`);
      }
      hasher.update(buf);
      writeSync(fd, buf);
    }
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw err;
  }

  const digest = hasher.digest("hex");
  if (received !== meta.size || digest !== meta.sha256) {
    rmSync(tmpPath, { force: true });
    throw new ArtifactUploadError(
      "mismatch",
      `artifact mismatch: declared ${meta.sha256}/${meta.size}, actual ${digest}/${received}`,
    );
  }

  const blobPath = blobPathFor(core.dirs, meta.sha256);
  const db = core.db;
  let result: SubmitResult;
  let placed = false;
  db.exec("BEGIN");
  try {
    if (existsSync(blobPath)) {
      // 去重复用：同内容已在盘中，丢弃临时文件
      rmSync(tmpPath, { force: true });
    } else {
      mkdirSync(join(core.dirs.attachmentsDir, meta.sha256.slice(0, 2)), { recursive: true });
      renameSync(tmpPath, blobPath);
      placed = true;
    }
    result = host.submit(event, { transaction: true });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    rmSync(tmpPath, { force: true });
    if (placed) rmSync(blobPath, { force: true });
    throw err;
  }
  if (!result.duplicate) host.broadcastSubmit(result);

  return { seq: result.seq, duplicate: result.duplicate, artifactId: meta.artifactId };
}

export interface FetchedBlob {
  meta: ArtifactMeta;
  blobPath: string;
}

/** 按 artifactId 从投影定位 blob（投影无记录或 blob 缺失 → undefined） */
export function fetchBlob(
  core: DaemonCore,
  workspaceId: string,
  artifactId: string,
): FetchedBlob | undefined {
  const record = new WorkspaceHost(core, workspaceId)
    .state()
    .artifacts.find((a) => a.payload.artifactId === artifactId);
  if (!record) return undefined;
  const blobPath = blobPathFor(core.dirs, record.payload.sha256);
  if (!existsSync(blobPath)) return undefined;
  return { meta: record.payload, blobPath };
}

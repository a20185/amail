/**
 * 工作区工件路由（lan=true）：
 *
 * - POST /ws/:id/artifacts —— 原始字节 body + `X-Amail-Meta` 头（base64url(JSON) 的上传方签名事件）。
 *   路由不预读 JSON（Route.raw），字节流直接交给 receiveUpload；
 *   认证 = 事件签名（成员 + 配对公钥），载荷完整性 = meta.sha256/size 双校验。
 * - GET /ws/:id/artifacts —— 投影列表（X-Amail-Sig 成员门）
 * - GET /ws/:id/artifacts/:artifactId —— blob 流（X-Amail-Sig 成员门）
 *
 * 通用 /ws/:id/events 对 artifact 仍 422（拒绝门只在通用路由层，此处为唯一上传入口）。
 */
import { createReadStream } from "node:fs";
import { sendJson, type Route, type RouteCtx } from "../router.js";
import { WorkspaceHost, getWorkspaceRow, type WorkspaceRow } from "../../workspace/host.js";
import { ArtifactUploadError, decodeUploadMeta, fetchBlob, receiveUpload } from "../../workspace/artifacts.js";
import { checkRequestSig } from "./workspace.js";

function header(ctx: RouteCtx, name: string): string | undefined {
  const value = ctx.req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function workspaceOr404(ctx: RouteCtx): WorkspaceRow | undefined {
  const row = getWorkspaceRow(ctx.db, ctx.params.id!);
  if (!row) {
    sendJson(ctx.res, 404, { error: "unknown-workspace" });
    return undefined;
  }
  return row;
}

/** 成员/房主统一验签门（401/403 语义同 workspace 路由） */
function gate(ctx: RouteCtx, row: WorkspaceRow): boolean {
  const host = new WorkspaceHost(ctx, row.id);
  const result = checkRequestSig(ctx, host.state().members, host.hostAddr);
  if (!result.ok) {
    sendJson(ctx.res, result.status ?? 401, {
      error: result.status === 403 ? "not-a-member" : "unauthorized",
    });
    return false;
  }
  return true;
}

async function handleUpload(ctx: RouteCtx): Promise<void> {
  const row = workspaceOr404(ctx);
  if (!row) return;
  const raw = header(ctx, "X-Amail-Meta");
  if (!raw) {
    sendJson(ctx.res, 400, { error: "missing-meta" });
    return;
  }
  let signedEvent: unknown;
  try {
    signedEvent = decodeUploadMeta(raw);
  } catch {
    sendJson(ctx.res, 400, { error: "invalid-meta" });
    return;
  }
  try {
    const result = await receiveUpload(ctx, row.id, ctx.req, signedEvent);
    sendJson(ctx.res, result.duplicate ? 200 : 201, {
      seq: result.seq,
      artifactId: result.artifactId,
      duplicate: result.duplicate,
    });
  } catch (err) {
    if (err instanceof ArtifactUploadError) {
      sendJson(ctx.res, err.status, { error: err.code, detail: err.message });
      return;
    }
    throw err;
  }
}

function handleList(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const host = new WorkspaceHost(ctx, row.id);
  sendJson(ctx.res, 200, { workspaceId: row.id, artifacts: host.state().artifacts });
}

function handleFetch(ctx: RouteCtx): void {
  const row = workspaceOr404(ctx);
  if (!row) return;
  if (!gate(ctx, row)) return;
  const artifactId = ctx.params.artifactId!;
  const found = fetchBlob(ctx, row.id, artifactId);
  if (!found) {
    sendJson(ctx.res, 404, { error: "unknown-artifact", artifactId });
    return;
  }
  const { meta, blobPath } = found;
  ctx.res.writeHead(200, {
    "content-type": meta.mime,
    "content-length": String(meta.size),
    "x-amail-sha256": meta.sha256,
  });
  const stream = createReadStream(blobPath);
  stream.on("error", () => {
    if (!ctx.res.headersSent) sendJson(ctx.res, 500, { error: "blob-read-failed" });
    else ctx.res.destroy();
  });
  stream.pipe(ctx.res);
}

const routes: Route[] = [
  { method: "POST", path: "/ws/:id/artifacts", lan: true, raw: true, handler: handleUpload },
  { method: "GET", path: "/ws/:id/artifacts", lan: true, handler: handleList },
  { method: "GET", path: "/ws/:id/artifacts/:artifactId", lan: true, handler: handleFetch },
];

export default routes;

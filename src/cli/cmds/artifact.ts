/**
 * amail artifact —— 工作区工件提交 / 列表 / 拉取
 *
 * - amail artifact submit <file> [--note] [--tag]… [--ws <workspaceId>]
 *   本地计算 sha256/size/mime，构造并签名 artifact 事件，随原始字节经
 *   POST /ws/:id/artifacts 的 X-Amail-Meta 头上传（工作区解析规则同 ws 命令）。
 * - amail artifact list [--ws <workspaceId>]
 * - amail artifact fetch <artifactId> [-o out] [--ws <workspaceId>]
 *   下载后本地校验 sha256（不匹配报错，不落盘）。
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ulid } from "ulid";
import type { Command } from "commander";
import { sha256Hex } from "../../core/crypto.js";
import { amailSigHeaders } from "../../workspace/projection-local.js";
import { makeEvent, type ArtifactRecord } from "../../workspace/events.js";
import type { WorkspaceRow } from "../../workspace/host.js";
import { MAX_ARTIFACT_BYTES, encodeUploadMeta } from "../../workspace/artifacts.js";
import { openWsCtx, resolveWorkspaceBase, resolveWs, type WsCtx, type WsOptions } from "./ws.js";

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

export function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function signedGet(ctx: WsCtx, row: WorkspaceRow, path: string): Promise<Response> {
  const base = await resolveWorkspaceBase(ctx, row);
  const pathname = path.split("?")[0]!;
  return fetch(`${base}${path}`, {
    headers: amailSigHeaders(ctx.identity.signPrivPem, "GET", pathname, "", ctx.myAddr),
  });
}

export interface ArtifactSubmitOptions extends WsOptions {
  note?: string;
  tags?: string[];
}

export interface ArtifactSubmitResult {
  artifactId: string;
  seq: number;
  duplicate: boolean;
}

export async function runArtifactSubmit(
  file: string,
  options: ArtifactSubmitOptions = {},
): Promise<ArtifactSubmitResult> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const size = statSync(file).size;
  if (size > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact too large: ${size} bytes (limit ${MAX_ARTIFACT_BYTES})`);
  }
  const bytes = readFileSync(file);
  const sha256 = sha256Hex(bytes);
  const artifactId = `art_${ulid()}`;
  const event = makeEvent(ctx.identity.signPrivPem, ctx.myAddr, "artifact", {
    artifactId,
    name: basename(file),
    mime: mimeFor(file),
    size: bytes.length,
    note: options.note,
    tags: options.tags ?? [],
    sha256,
  });

  const pathname = `/ws/${row.id}/artifacts`;
  const base = await resolveWorkspaceBase(ctx, row);
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "X-Amail-Meta": encodeUploadMeta(event),
    },
    body: bytes,
  });
  const out = (await res.json().catch(() => ({}))) as {
    seq?: number;
    artifactId?: string;
    duplicate?: boolean;
    error?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(`upload ${res.status}: ${String(out.detail ?? out.error ?? res.statusText)}`);
  }
  const result = {
    artifactId: out.artifactId ?? artifactId,
    seq: out.seq ?? 0,
    duplicate: out.duplicate === true,
  };
  console.log(
    `artifact submitted: ${result.artifactId} (seq ${result.seq}${result.duplicate ? ", duplicate" : ""})`,
  );
  return result;
}

export async function runArtifactList(options: WsOptions = {}): Promise<ArtifactRecord[]> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const res = await signedGet(ctx, row, `/ws/${row.id}/artifacts`);
  const body = (await res.json().catch(() => ({}))) as { artifacts?: ArtifactRecord[]; error?: string };
  if (!res.ok) throw new Error(`list ${res.status}: ${String(body.error ?? res.statusText)}`);
  const artifacts = body.artifacts ?? [];
  if (artifacts.length === 0) console.log("no artifacts");
  for (const a of artifacts) {
    const tags = a.payload.tags.length ? ` [${a.payload.tags.join(", ")}]` : "";
    const note = a.payload.note ? ` — ${a.payload.note}` : "";
    console.log(
      `${a.payload.artifactId}\t${a.payload.name}\t${a.payload.mime}\t${a.payload.size}B\tsha256=${a.payload.sha256}${tags}${note}`,
    );
  }
  return artifacts;
}

export interface ArtifactFetchOptions extends WsOptions {
  out?: string;
}

export interface ArtifactFetchResult {
  path: string;
  sha256: string;
}

export async function runArtifactFetch(
  artifactId: string,
  options: ArtifactFetchOptions = {},
): Promise<ArtifactFetchResult> {
  const ctx = openWsCtx(options.env);
  const row = resolveWs(ctx, options.ws);
  const listRes = await signedGet(ctx, row, `/ws/${row.id}/artifacts`);
  const listBody = (await listRes.json().catch(() => ({}))) as {
    artifacts?: ArtifactRecord[];
    error?: string;
  };
  if (!listRes.ok) throw new Error(`list ${listRes.status}: ${String(listBody.error ?? listRes.statusText)}`);
  const record = listBody.artifacts?.find((a) => a.payload.artifactId === artifactId);
  if (!record) throw new Error(`unknown artifact: ${artifactId}`);

  const res = await signedGet(ctx, row, `/ws/${row.id}/artifacts/${artifactId}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`fetch ${res.status}: ${String(body.error ?? res.statusText)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256 = sha256Hex(bytes);
  if (sha256 !== record.payload.sha256 || bytes.length !== record.payload.size) {
    throw new Error(
      `artifact hash mismatch: declared ${record.payload.sha256}/${record.payload.size}, actual ${sha256}/${bytes.length}`,
    );
  }
  const outPath = options.out ?? join(process.cwd(), basename(record.payload.name));
  writeFileSync(outPath, bytes);
  console.log(`${outPath} (sha256 ${sha256})`);
  return { path: outPath, sha256 };
}

export default function register(program: Command): void {
  const artifact = program
    .command("artifact")
    .description("workspace artifacts (submit / list / fetch blobs)");

  artifact
    .command("submit")
    .description("upload a file as a workspace artifact (signed event + sha256/size checks)")
    .argument("<file>", "file to upload (≤10MB)")
    .option("--note <note>", "short note shown in listings")
    .option("--tag <tag>", "tag (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)")
    .action(async (file: string, opts: { note?: string; tag: string[]; ws?: string }) => {
      await runArtifactSubmit(file, { note: opts.note, tags: opts.tag, ws: opts.ws });
    });

  artifact
    .command("list")
    .description("list workspace artifacts (projection)")
    .option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)")
    .action(async (opts: { ws?: string }) => {
      await runArtifactList({ ws: opts.ws });
    });

  artifact
    .command("fetch")
    .description("download an artifact blob and verify its sha256")
    .argument("<artifactId>", "artifact id (art_…)")
    .option("-o, --out <path>", "output path (defaults to ./<artifact name>)")
    .option("--ws <workspaceId>", "workspace id (defaults to the single local workspace)")
    .action(async (artifactId: string, opts: { out?: string; ws?: string }) => {
      await runArtifactFetch(artifactId, { out: opts.out, ws: opts.ws });
    });
}

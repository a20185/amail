import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, sha256Hex } from "../../core/crypto.js";
import { makeEvent } from "../../workspace/events.js";
import { createWorkspace, WorkspaceHost } from "../../workspace/host.js";
import { acceptInvite, type WorkspaceInvite } from "../../workspace/invite.js";
import { amailSigHeaders } from "../../workspace/projection-local.js";
import { MAX_ARTIFACT_BYTES, encodeUploadMeta } from "../../workspace/artifacts.js";
import type { ArtifactMeta } from "../../contract/attachment.js";
import type { ArtifactRecord } from "../../workspace/events.js";
import { pairDual, startDual, type DualSandbox } from "../e2e-kit.js";
import { resetDeliveryConfig } from "../../core/delivery.js";
import type { DaemonHandle } from "../server.js";

const handles: DaemonHandle[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  for (const handle of handles.splice(0)) await handle.stop();
});

interface Dual extends DualSandbox {
  wsId: string;
}

async function dual(tag: string): Promise<Dual> {
  const sandbox = await startDual(`amail-ws-art-${tag}`);
  handles.push(sandbox.a, sandbox.b);
  await pairDual(sandbox);
  const wsId = createWorkspace(sandbox.a, { name: "Proj", projectSlug: "proj" });
  const invite = (await (
    await hostFetch(sandbox.a, `/ws/${wsId}/invite`, { method: "POST", body: {} })
  ).json()) as WorkspaceInvite;
  await acceptInvite(sandbox.b.dirs, invite);
  return { ...sandbox, wsId };
}

async function hostFetch(a: DaemonHandle, path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? "GET";
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  return fetch(`http://127.0.0.1:${a.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(a.identity.signPrivPem, method, pathname, bodyText, a.address),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
}

/** 成员（LAN 来源）签名请求打到房主 A */
async function memberFetch(
  b: DaemonHandle,
  a: DaemonHandle,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const method = init.method ?? "GET";
  const pathname = path.split("?")[0]!;
  const bodyText = init.body === undefined ? "" : canonicalStringify(init.body);
  return fetch(`http://127.0.0.1:${a.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...amailSigHeaders(b.identity.signPrivPem, method, pathname, bodyText, b.address),
    },
    body: init.body === undefined ? undefined : bodyText,
  });
}

let artifactCounter = 0;
const ULID_SUFFIX = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

function artifactMeta(bytes: Buffer, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  artifactCounter += 1;
  const id = `art_${String(artifactCounter).padStart(2, "0")}${ULID_SUFFIX.slice(0, 24)}`;
  return {
    artifactId: id,
    name: "notes.md",
    mime: "text/markdown",
    size: bytes.length,
    note: "from member",
    tags: ["p8"],
    sha256: sha256Hex(bytes),
    ...overrides,
  };
}

/** 原始字节上传：X-Amail-Meta（事件签名）+ X-Amail-Sig（统一请求签名门，绑定原始字节哈希） */
async function uploadRaw(a: DaemonHandle, wsId: string, bytes: Buffer, meta: ArtifactMeta, signer: DaemonHandle) {
  const event = makeEvent(signer.identity.signPrivPem, signer.address, "artifact", meta);
  const pathname = `/ws/${wsId}/artifacts`;
  return fetch(`http://127.0.0.1:${a.port}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "X-Amail-Meta": encodeUploadMeta(event),
      ...amailSigHeaders(
        signer.identity.signPrivPem,
        "POST",
        pathname,
        "",
        signer.address,
        sha256Hex(bytes),
      ),
    },
    body: bytes,
  });
}

describe("ws artifacts routes: 上传→事件→两端列表→拉取校验", () => {
  it("成员上传：房主验签+双校验落库；房主/成员两端列表一致；拉取原始字节哈希一致", async () => {
    const { a, b, wsId } = await dual("roundtrip");
    const bytes = Buffer.from("# notes\nartifact payload\n", "utf8");
    const meta = artifactMeta(bytes);

    const res = await uploadRaw(a, wsId, bytes, meta, b);
    expect(res.status).toBe(201);
    const submitted = (await res.json()) as { seq: number; artifactId: string };
    expect(submitted.artifactId).toBe(meta.artifactId);

    // 房主侧：事件投影
    const hostState = new WorkspaceHost(a, wsId).state();
    expect(hostState.artifacts.map((x) => x.payload)).toEqual([meta]);

    // 两端列表（同一房主权威端点）
    const hostList = (await (await hostFetch(a, `/ws/${wsId}/artifacts`)).json()) as {
      artifacts: ArtifactRecord[];
    };
    const memberList = (await (await memberFetch(b, a, `/ws/${wsId}/artifacts`)).json()) as {
      artifacts: ArtifactRecord[];
    };
    expect(hostList.artifacts.map((x) => x.payload)).toEqual([meta]);
    expect(memberList.artifacts.map((x) => x.payload)).toEqual([meta]);

    // 成员拉取 blob → 哈希与字节一致
    const blobRes = await memberFetch(b, a, `/ws/${wsId}/artifacts/${meta.artifactId}`);
    expect(blobRes.status).toBe(200);
    expect(blobRes.headers.get("content-type")).toBe(meta.mime);
    expect(blobRes.headers.get("x-amail-sha256")).toBe(meta.sha256);
    const downloaded = Buffer.from(await blobRes.arrayBuffer());
    expect(downloaded).toEqual(bytes);
    expect(sha256Hex(downloaded)).toBe(meta.sha256);

    // 相同内容再次上传（新事件）→ blob 去重复用，事件仍追加
    const second = artifactMeta(bytes);
    expect((await uploadRaw(a, wsId, bytes, second, b)).status).toBe(201);
    expect(new WorkspaceHost(a, wsId).state().artifacts).toHaveLength(2);
  });

  it("缺 meta 头 400；JSON 非法 400；哈希/大小不匹配 422；超 10MB 413；缺签名列表 401", async () => {
    const { a, b, wsId } = await dual("errors");
    const bytes = Buffer.from("abc", "utf8");

    const missing = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toBe("missing-meta");

    const badJson = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "X-Amail-Meta": "{" },
      body: bytes,
    });
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as { error: string };
    expect(badJsonBody.error).toBe("invalid-meta");

    const mismatch = await uploadRaw(a, wsId, bytes, artifactMeta(bytes, { size: 99 }), b);
    expect(mismatch.status).toBe(422);
    const mismatchBody = (await mismatch.json()) as { error: string };
    expect(mismatchBody.error).toBe("mismatch");

    const oversized = await uploadRaw(
      a,
      wsId,
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 7),
      artifactMeta(Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 7)),
      b,
    );
    expect(oversized.status).toBe(413);

    // 失败请求不落任何事件 / blob 引用
    expect(new WorkspaceHost(a, wsId).state().artifacts).toHaveLength(0);

    // 列表/拉取需要 X-Amail-Sig
    expect((await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/artifacts`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/artifacts/art_x`)).status).toBe(401);
    expect((await hostFetch(a, `/ws/${wsId}/artifacts/art_x`)).status).toBe(404);
  });

  it("非成员上传（已配对但未入区）→ 403 not-member", async () => {
    const sandbox = await startDual("amail-ws-art-outsider");
    handles.push(sandbox.a, sandbox.b);
    await pairDual(sandbox);
    const wsId = createWorkspace(sandbox.a, { name: "Proj", projectSlug: "proj" });
    const bytes = Buffer.from("sneak", "utf8");
    const res = await uploadRaw(sandbox.a, wsId, bytes, artifactMeta(bytes), sandbox.b);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not-member");
    expect(new WorkspaceHost(sandbox.a, wsId).state().artifacts).toHaveLength(0);
  });

  it("上传请求签名门：缺 X-Amail-Sig 401；跨工作区重放 401 且不落库", async () => {
    const { a, b, wsId } = await dual("upload-sig");
    const bytes = Buffer.from("upload-sig-bytes", "utf8");
    const meta = artifactMeta(bytes);
    const event = makeEvent(b.identity.signPrivPem, b.address, "artifact", meta);

    // 事件签名齐全但缺请求签名 → 401
    const unsigned = await fetch(`http://127.0.0.1:${a.port}/ws/${wsId}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Amail-Meta": encodeUploadMeta(event),
      },
      body: bytes,
    });
    expect(unsigned.status).toBe(401);

    // 为 ws1 签发的请求头重放到 ws2（路径入签名）→ 401
    const ws2 = createWorkspace(a, { name: "Other", projectSlug: "other" });
    const invite2 = (await (
      await hostFetch(a, `/ws/${ws2}/invite`, { method: "POST", body: {} })
    ).json()) as WorkspaceInvite;
    await acceptInvite(b.dirs, invite2);
    const headers = amailSigHeaders(
      b.identity.signPrivPem,
      "POST",
      `/ws/${wsId}/artifacts`,
      "",
      b.address,
      sha256Hex(bytes),
    );
    const replay = await fetch(`http://127.0.0.1:${a.port}/ws/${ws2}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Amail-Meta": encodeUploadMeta(event),
        "X-Amail-Sig": headers["X-Amail-Sig"]!,
        "X-Amail-Date": headers["X-Amail-Date"]!,
        "X-Amail-Actor": headers["X-Amail-Actor"]!,
      },
      body: bytes,
    });
    expect(replay.status).toBe(401);
    expect(new WorkspaceHost(a, ws2).state().artifacts).toHaveLength(0);
  });

  it("通用 /events 仍拒绝 artifact（422 use-upload-endpoint）", async () => {
    const { a, wsId } = await dual("gate");
    const bytes = Buffer.from("x", "utf8");
    const event = makeEvent(a.identity.signPrivPem, a.address, "artifact", artifactMeta(bytes));
    const res = await hostFetch(a, `/ws/${wsId}/events`, { method: "POST", body: event });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("use-upload-endpoint");
  });
});

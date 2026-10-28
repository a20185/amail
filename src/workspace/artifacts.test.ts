import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDirs } from "../core/paths.js";
import { sha256Hex } from "../core/crypto.js";
import { startDaemon, type DaemonHandle } from "../daemon/server.js";
import { createWorkspace, WorkspaceHost } from "./host.js";
import { makeEvent } from "./events.js";
import {
  ArtifactUploadError,
  MAX_ARTIFACT_BYTES,
  blobPathFor,
  fetchBlob,
  receiveUpload,
} from "./artifacts.js";

const ROUTES_DIR = fileURLToPath(new URL("../daemon/routes", import.meta.url));
const handles: DaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
});

async function host(tag: string): Promise<{ handle: DaemonHandle; wsId: string }> {
  const home = mkdtempSync(join(tmpdir(), `amail-artifacts-${tag}-`));
  const dirs = resolveDirs({ AMAIL_HOME: home });
  const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR });
  handles.push(handle);
  const wsId = createWorkspace(handle, { name: "Proj", projectSlug: "proj" });
  return { handle, wsId };
}

const ARTIFACT_ID = "art_01HGV2KP5Z4W7R8X9Y0ZABCDFG";

function artifactEvent(
  handle: DaemonHandle,
  bytes: Buffer,
  overrides: Partial<{ sha256: string; size: number; artifactId: string }> = {},
) {
  const event = makeEvent(handle.identity.signPrivPem, handle.address, "artifact", {
    artifactId: overrides.artifactId ?? ARTIFACT_ID,
    name: "report.txt",
    mime: "text/plain",
    size: overrides.size ?? bytes.length,
    note: "phase",
    tags: ["t"],
    sha256: overrides.sha256 ?? sha256Hex(bytes),
  });
  if (event.kind !== "artifact") throw new Error("expected artifact event");
  return event;
}

async function upload(handle: DaemonHandle, wsId: string, bytes: Buffer, event: unknown) {
  return receiveUpload(handle, wsId, Readable.from([bytes]), event);
}

async function expectUploadError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ArtifactUploadError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("workspace artifacts: receiveUpload", () => {
  it("落临时文件→双校验→单事务落位 blob + submit 定序→可 fetchBlob", async () => {
    const { handle, wsId } = await host("roundtrip");
    const bytes = Buffer.from("hello artifact\n", "utf8");
    const event = artifactEvent(handle, bytes);

    const result = await upload(handle, wsId, bytes, event);
    expect(result.seq).toBe(2);
    expect(result.duplicate).toBe(false);
    expect(result.artifactId).toBe(event.payload.artifactId);

    const state = new WorkspaceHost(handle, wsId).state();
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]!.payload).toEqual(event.payload);
    expect(state.artifacts[0]!.seq).toBe(2);

    const blob = blobPathFor(handle.dirs, event.payload.sha256);
    expect(existsSync(blob)).toBe(true);
    expect(readFileSync(blob)).toEqual(bytes);

    const fetched = fetchBlob(handle, wsId, event.payload.artifactId);
    expect(fetched?.blobPath).toBe(blob);
    expect(fetched?.meta.sha256).toBe(sha256Hex(bytes));
  });

  it("同 eventId 重放幂等 duplicate；同内容不同事件去重复用 blob", async () => {
    const { handle, wsId } = await host("dup");
    const bytes = Buffer.from("same-bytes", "utf8");
    const event = artifactEvent(handle, bytes);
    await upload(handle, wsId, bytes, event);
    const again = await upload(handle, wsId, bytes, event);
    expect(again.duplicate).toBe(true);
    expect(again.seq).toBe(2);
    expect(new WorkspaceHost(handle, wsId).state().artifacts).toHaveLength(1);

    // 新事件、同内容 → blob 复用，不重复落盘
    const second = artifactEvent(handle, bytes, { artifactId: "art_01HGV2KP5Z4W7R8X9Y0ZABCDFH" });
    const other = await upload(handle, wsId, bytes, second);
    expect(other.seq).toBe(3);
    expect(new WorkspaceHost(handle, wsId).state().artifacts).toHaveLength(2);
    const dir = blobPathFor(handle.dirs, sha256Hex(bytes));
    expect(existsSync(dir)).toBe(true);
  });

  it("实际字节数与 size / sha256 双校验：不匹配 422 语义，不落库", async () => {
    const { handle, wsId } = await host("mismatch");
    const bytes = Buffer.from("payload", "utf8");

    await expectUploadError(upload(handle, wsId, bytes, artifactEvent(handle, bytes, { size: bytes.length + 1 })), "mismatch");
    await expectUploadError(
      upload(handle, wsId, bytes, artifactEvent(handle, bytes, { sha256: "b".repeat(64) })),
      "mismatch",
    );
    expect(new WorkspaceHost(handle, wsId).state().artifacts).toHaveLength(0);
    expect(fetchBlob(handle, wsId, ARTIFACT_ID)).toBeUndefined();
  });

  it("单文件 ≤10MB：声明超限与实际超限都 413 语义", async () => {
    const { handle, wsId } = await host("limit");
    const big = Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 1);
    const declared = artifactEvent(handle, big);
    await expectUploadError(upload(handle, wsId, big, declared), "too-large");

    const small = Buffer.from("x", "utf8");
    const lying = makeEvent(handle.identity.signPrivPem, handle.address, "artifact", {
      artifactId: ARTIFACT_ID,
      name: "x.txt",
      mime: "text/plain",
      size: MAX_ARTIFACT_BYTES + 5,
      tags: [],
      sha256: sha256Hex(small),
    });
    await expectUploadError(upload(handle, wsId, small, lying), "too-large");
  });

  it("非成员 actor / 伪造签名 / 非 artifact kind → 拒绝且不落库", async () => {
    const { handle, wsId } = await host("auth");
    const bytes = Buffer.from("x", "utf8");

    const foreign = makeEvent(handle.identity.signPrivPem, "eve@eve-box", "artifact", {
      artifactId: ARTIFACT_ID,
      name: "x.txt",
      mime: "text/plain",
      size: bytes.length,
      tags: [],
      sha256: sha256Hex(bytes),
    });
    await expectUploadError(upload(handle, wsId, bytes, foreign), "not-member");

    const forged = { ...artifactEvent(handle, bytes), sig: "Zm9yZ2Vk" };
    await expectUploadError(upload(handle, wsId, bytes, forged), "bad-sig");

    const notArtifact = makeEvent(handle.identity.signPrivPem, handle.address, "todo", {
      id: `td_${"01HGV2KP5Z4W7R8X9Y0ZABCDFG".slice(0, 26)}`,
      title: "x",
      priority: 2,
      status: "todo",
    });
    await expectUploadError(upload(handle, wsId, bytes, notArtifact), "invalid-event");
    expect(new WorkspaceHost(handle, wsId).state().artifacts).toHaveLength(0);
  });
});

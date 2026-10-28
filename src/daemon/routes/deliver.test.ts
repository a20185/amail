import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baseUrl, pairDual, postJson, refreshMdns, startDual, until, ROUTES_DIR } from "../e2e-kit.js";
import { startDaemon, type DaemonHandle } from "../server.js";
import { resetDeliveryConfig, scanOutbox } from "../../core/delivery.js";
import { get as getMessage } from "../../core/store.js";
import { buildDeliverReq } from "../../cli/testkit.js";
import { sha256Hex } from "../../core/crypto.js";

const handles: DaemonHandle[] = [];

afterEach(async () => {
  resetDeliveryConfig();
  while (handles.length) {
    const handle = handles.pop();
    await handle?.stop();
  }
});

interface Dual {
  a: DaemonHandle;
  b: DaemonHandle;
  addrA: string;
  addrB: string;
}

async function dual(tag: string): Promise<Dual> {
  const sandbox = await startDual(`amail-dlv-${tag}`);
  handles.push(sandbox.a, sandbox.b);
  await pairDual(sandbox);
  return sandbox;
}

interface AttachmentRow {
  id: string;
  blob_path: string;
  size: number;
  sha256: string;
}

function attachmentsOf(b: DaemonHandle, messageId: string): AttachmentRow[] {
  return b.db
    .prepare("SELECT id, blob_path, size, sha256 FROM attachments WHERE message_id = ?")
    .all(messageId) as unknown as AttachmentRow[];
}

function receiptsOf(handle: DaemonHandle, messageId: string): string[] {
  return (
    handle.db
      .prepare("SELECT kind FROM receipts WHERE message_id = ?")
      .all(messageId) as unknown as Array<{ kind: string }>
  ).map((r) => r.kind);
}

/** A 经 /v1/send 发信（daemon 即时直投） */
async function sendFromA(
  a: DaemonHandle,
  addrB: string,
  over: { refs?: string[] } = {},
): Promise<string> {
  const res = await postJson<{ messageId: string }>(baseUrl(a), "/v1/send", {
    to: addrB,
    subject: "e2e subject",
    body: "e2e body",
    refs: over.refs ?? [],
  });
  expect(res.status).toBe(200);
  return res.json.messageId;
}

describe("e2e LAN 直投（双 daemon + fake mdns）", () => {
  it("A→B 直投（含 1 附件 part）：B 落库+哈希/size 校验+new-mail 事件+delivered", async () => {
    const { a, b, addrB } = await dual("attach");
    const ref = join(tmpdir(), `amail-ref-${Date.now()}.bin`);
    const payload = Buffer.from("attachment-bytes-0123456789");
    writeFileSync(ref, payload);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    b.bus.on((event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }));

    const messageId = await sendFromA(a, addrB, { refs: [ref] });
    expect(await until(() => getMessage(b.db, messageId) !== undefined)).toBe(true);

    const message = getMessage(b.db, messageId);
    expect(message?.body).toBe("e2e body");
    expect(message?.from_addr).toBe(a.address);

    const [att] = attachmentsOf(b, messageId);
    expect(att).toBeDefined();
    expect(att.size).toBe(payload.length);
    expect(att.sha256).toBe(sha256Hex(payload));
    expect(existsSync(att.blob_path)).toBe(true);
    expect(readFileSync(att.blob_path).equals(payload)).toBe(true);

    expect(events.some((e) => e.type === "new-mail" && e.data.id === messageId)).toBe(true);

    // A 侧出箱 delivered + 收到 delivered 回执
    expect(await until(() => receiptsOf(a, messageId).includes("delivered"))).toBe(true);
    const outboxRow = a.db
      .prepare("SELECT state FROM outbox WHERE payload_json LIKE ?")
      .get(`%${messageId}%`) as { state: string } | undefined;
    expect(outboxRow?.state).toBe("delivered");
  });

  it("send 后在线对端 1s 内收到（bus outbox 即时直投）", async () => {
    const { a, b, addrB } = await dual("fast");
    const startAt = Date.now();
    const messageId = await sendFromA(a, addrB);
    expect(await until(() => getMessage(b.db, messageId) !== undefined, 1_000)).toBe(true);
    expect(Date.now() - startAt).toBeLessThanOrEqual(1_000);
  });

  it("envelope sig 篡改 → 401 not 拒收", async () => {
    const { a, b, addrA, addrB } = await dual("badsig");
    const req = buildDeliverReq(a.identity, b.identity, { fromAddr: addrA, toAddr: addrB });
    req.envelope.sig = req.envelope.sig.startsWith("A")
      ? `B${req.envelope.sig.slice(1)}`
      : `A${req.envelope.sig.slice(1)}`;
    const res = await postJson(baseUrl(b), "/v1/deliver", req);
    expect(res.status).toBe(401);
    expect(getMessage(b.db, req.envelope.id)).toBeUndefined();
  });

  it("重放（同 id 二投）幂等 200，B 只落一条", async () => {
    const { a, b, addrA, addrB } = await dual("replay");
    const req = buildDeliverReq(a.identity, b.identity, { fromAddr: addrA, toAddr: addrB });
    const first = await postJson(baseUrl(b), "/v1/deliver", req);
    expect(first.status).toBe(200);
    const second = await postJson<{ idempotent?: boolean }>(baseUrl(b), "/v1/deliver", req);
    expect(second.status).toBe(200);
    expect(second.json.idempotent).toBe(true);
    const count = (
      b.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(req.envelope.id) as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  it("未来信（createdAt > now+10min）409 拒收；历史信（< now-1h）接受", async () => {
    const { a, b, addrA, addrB } = await dual("time");
    const future = buildDeliverReq(a.identity, b.identity, {
      fromAddr: addrA,
      toAddr: addrB,
      createdAt: new Date(Date.now() + 11 * 60_000).toISOString(),
    });
    expect((await postJson(baseUrl(b), "/v1/deliver", future)).status).toBe(409);
    expect(getMessage(b.db, future.envelope.id)).toBeUndefined();

    const past = buildDeliverReq(a.identity, b.identity, {
      fromAddr: addrA,
      toAddr: addrB,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect((await postJson(baseUrl(b), "/v1/deliver", past)).status).toBe(200);
    expect(getMessage(b.db, past.envelope.id)?.id).toBe(past.envelope.id);
  });

  it("附件声明 size 与实际不符 → 422 拒收", async () => {
    const { a, b, addrA, addrB } = await dual("size");
    const req = buildDeliverReq(a.identity, b.identity, {
      fromAddr: addrA,
      toAddr: addrB,
      attachments: [{ id: "att_01M61CHRC25BCYH10EHVCHSPRE", name: "a.bin", bytes: Buffer.from("real-bytes"), declaredSize: 999 }],
    });
    const res = await postJson(baseUrl(b), "/v1/deliver", req);
    expect(res.status).toBe(422);
    expect(getMessage(b.db, req.envelope.id)).toBeUndefined();
  });

  it("单附件 >10MB → 413", async () => {
    const { a, b, addrA, addrB } = await dual("big");
    const req = buildDeliverReq(a.identity, b.identity, {
      fromAddr: addrA,
      toAddr: addrB,
      attachments: [
        {
          id: "att_01M61CHRC25BCYH10EHVCHSPRE",
          name: "huge.bin",
          bytes: Buffer.alloc(1),
          declaredSize: 10 * 1024 * 1024 + 1,
        },
      ],
    });
    const res = await postJson(baseUrl(b), "/v1/deliver", req);
    expect(res.status).toBe(413);
  });

  it("B 离线 → A 出箱退避；B 恢复后 30s 扫描重试成功", async () => {
    const { a, b, addrB } = await dual("offline");
    const bDirs = b.dirs;
    await b.stop();
    handles.pop();

    const messageId = await sendFromA(a, addrB);
    // 即时直投失败 → 出箱记录一次失败尝试
    expect(
      await until(() => {
        const row = a.db
          .prepare("SELECT attempts FROM outbox WHERE payload_json LIKE ?")
          .get(`%${messageId}%`) as { attempts: number } | undefined;
        return (row?.attempts ?? 0) >= 1;
      }),
    ).toBe(true);

    // B 恢复（新随机端口）→ fake mdns 刷新 → 扫描重试
    const revived = await startDaemon({ port: 0, dirs: bDirs, routesDir: ROUTES_DIR });
    handles.push(revived);
    refreshMdns(a, revived);
    // 模拟退避到期（30s 扫描周期触发点）
    a.db
      .prepare("UPDATE outbox SET next_retry_at = ? WHERE payload_json LIKE ? AND state = 'queued'")
      .run(Date.now(), `%${messageId}%`);
    await scanOutbox(a);
    expect(getMessage(revived.db, messageId)?.id).toBe(messageId);
    const outboxRow = a.db
      .prepare("SELECT state FROM outbox WHERE payload_json LIKE ?")
      .get(`%${messageId}%`) as { state: string } | undefined;
    expect(outboxRow?.state).toBe("delivered");
  });

  it("B read → A 收到 read 回执", async () => {
    const { a, b, addrB } = await dual("read");
    const messageId = await sendFromA(a, addrB);
    expect(await until(() => getMessage(b.db, messageId) !== undefined)).toBe(true);

    const res = await postJson(baseUrl(b), "/v1/read", { id: messageId });
    expect(res.status).toBe(200);
    expect(await until(() => receiptsOf(a, messageId).includes("read"))).toBe(true);
  });

  it("B 吊销 A 后拒收：直投 401 not-paired，出箱保持 queued", async () => {
    const { a, b, addrA, addrB } = await dual("revoke");
    expect((await postJson(baseUrl(b), "/v1/peers/revoke", { addr: addrA })).status).toBe(200);

    const req = buildDeliverReq(a.identity, b.identity, { fromAddr: addrA, toAddr: addrB });
    const res = await postJson(baseUrl(b), "/v1/deliver", req);
    expect(res.status).toBe(401);
    expect(getMessage(b.db, req.envelope.id)).toBeUndefined();

    // /v1/send 仍入箱，但投递失败留出箱
    const messageId = await sendFromA(a, addrB);
    expect(
      await until(() => {
        const row = a.db
          .prepare("SELECT attempts, state FROM outbox WHERE payload_json LIKE ?")
          .get(`%${messageId}%`) as { attempts: number; state: string } | undefined;
        return row !== undefined && row.attempts >= 1 && row.state === "queued";
      }),
    ).toBe(true);
  });
});

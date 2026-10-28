import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDirs } from "../core/paths.js";
import { expect } from "vitest";
import { configureDelivery } from "../core/delivery.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { MdnsDeps } from "./mdns.js";
import type { PairConfirmSig } from "../contract/pair.js";

/** 路由目录 = 本模块兄弟（进程内真路由发现，不依赖构建产物） */
export const ROUTES_DIR = fileURLToPath(new URL("./routes", import.meta.url));

/** fake mDNS 广播：测试不发真组播（assert 广播接线时注入自定义实现） */
export const fakeMdns: MdnsDeps = { advertiseImpl: async () => ({ end: async () => {} }) };

/** 测试内禁用真实桌面通知（AMAIL_NOTIFY_CMD 覆盖） */
process.env.AMAIL_NOTIFY_CMD ||= ":";

export interface DualSandbox {
  a: DaemonHandle;
  b: DaemonHandle;
  addrA: string;
  addrB: string;
}

async function post<T>(base: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

function local(handle: DaemonHandle): string {
  return `http://127.0.0.1:${handle.port}`;
}

/** 单节点沙箱：独立 AMAIL_HOME + config.json（name→地址人名段） */
export async function startNode(tag: string, name: string): Promise<DaemonHandle> {
  const home = mkdtempSync(join(tmpdir(), tag));
  const dirs = resolveDirs({ AMAIL_HOME: home });
  const write = (port: number) =>
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify({
        version: 1,
        name,
        email: `${name.toLowerCase()}@example.com`,
        port,
        notify: true,
      }),
      "utf8",
    );
  write(0);
  const handle = await startDaemon({ port: 0, dirs, routesDir: ROUTES_DIR, mdns: fakeMdns });
  write(handle.port);
  return handle;
}

/** fake mDNS：双端互见（B 重启换端口后调用 refreshMdns 刷新缓存） */
export function refreshMdns(a: DaemonHandle, b: DaemonHandle): void {
  const adv = (h: DaemonHandle) => ({
    name: `amail-${h.identity.deviceId}`,
    host: "127.0.0.1",
    port: h.port,
    txt: { fp: h.identity.deviceId, user: h.address, ver: "test" },
  });
  configureDelivery({ browse: async () => [adv(a), adv(b)] });
}

/** 两套 AMAIL_HOME 沙箱 + 双随机端口 daemon + fake mdns */
export async function startDual(tag: string): Promise<DualSandbox> {
  const a = await startNode(`${tag}-a-`, "Alice");
  const b = await startNode(`${tag}-b-`, "Bob");
  refreshMdns(a, b);
  return { a, b, addrA: a.address, addrB: b.address };
}

export interface PairResult {
  offerNonce: string;
  sasA: string;
  sasB: string;
  confirmA: PairConfirmSig;
  confirmB: PairConfirmSig;
}

/**
 * 完整配对编排（offer→answer→SAS→双确认）：
 * 与 CLI runPair 相同的 HTTP 序列，返回 SAS 与双端确认签名。
 */
export async function pairDual({ a, b }: DualSandbox): Promise<PairResult> {
  const offer = (
    await post<{ offer: { nonce: string } }>(local(a), "/v1/pair/local-offer")
  ).json.offer;
  expect((await post(local(b), "/v1/pair/offer", offer)).status, "offer forwarded").toBe(200);

  const answered = await post<{ answer: unknown; sas: string }>(
    local(b),
    `/v1/pair/local-answer/${offer.nonce}`,
  );
  expect(answered.status).toBe(200);
  const sasB = answered.json.sas;
  const answerRes = await post<{ sas: string }>(local(a), `/v1/pair/answer/${offer.nonce}`, answered.json.answer);
  expect(answerRes.status).toBe(200);
  const sasA = answerRes.json.sas;

  const confirmA = (await post<{ confirm: PairConfirmSig }>(local(a), `/v1/pair/local-confirm/${offer.nonce}`)).json
    .confirm;
  expect((await post(local(b), `/v1/pair/confirm/${offer.nonce}`, confirmA)).status).toBe(202);
  const confirmedB = await post<{ confirm: PairConfirmSig; stage: string }>(
    local(b),
    `/v1/pair/local-confirm/${offer.nonce}`,
  );
  expect(confirmedB.json.stage).toBe("confirmed");
  const confirmB = confirmedB.json.confirm;
  expect((await post(local(a), `/v1/pair/confirm/${offer.nonce}`, confirmB)).status).toBe(200);

  return { offerNonce: offer.nonce, sasA, sasB, confirmA, confirmB };
}

/** 轮询直至谓词为真（默认 2s 上限） */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export { post as postJson, local as baseUrl };

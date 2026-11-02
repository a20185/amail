import type { Command } from "commander";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";
import type { ScanItem } from "./peers.js";
import type { PairOffer, PairAnswer, PairConfirmSig } from "../../contract/pair.js";

export interface PairTarget {
  host: string;
  port: number;
}

export interface PairOptions {
  host?: string;
  port?: number;
  confirm?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface PendingOffer {
  offerNonce: string;
  /** 对端地址；本机发起且未 answer 时由 CLI 声明的目标地址回填 */
  user: string;
  deviceId: string | null;
  /** true = 本机发起（`--confirm` 复用 / 重跑显示 pending SAS）；false = 远端待应答 offer */
  local?: boolean;
  stage: PairStage;
}

type PairStage = "offer" | "answered" | "confirmed";

interface PairStatus {
  stage: PairStage;
  sas: string | null;
  peer: string | null;
}

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 5_000;

const DISCOVERY_HINT = "未发现该设备，先 `amail peers --scan` 或显式指定 --host/--port";

/**
 * 缺省 --host/--port 时经本机 daemon 的 mDNS 扫描解析对端 host/port：
 * TXT user（user@device）匹配地址，且 instance 名（`amail-<指纹>`）与 TXT fp 一致才采信（防冒名广播）。
 */
async function resolveTarget(dirs: Dirs, address: string): Promise<PairTarget> {
  const items = (await apiFetch(dirs, "/v1/peers/scan")) as ScanItem[];
  const target = address.toLowerCase();
  const found = items.find(
    (item) =>
      item.fp !== "" &&
      item.port > 0 &&
      item.user.toLowerCase() === target &&
      item.name.split(".")[0] === `amail-${item.fp}`,
  );
  if (!found) throw new Error(`${DISCOVERY_HINT}（${address}）`);
  return { host: found.host, port: found.port };
}

function targetBase(target: PairTarget): string {
  return `http://${target.host}:${target.port}`;
}

async function remoteJson(target: PairTarget, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${targetBase(target)}${path}`, init);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function pollStatus(dirs: Dirs, offerNonce: string): Promise<PairStatus> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const status = (await apiFetch(dirs, `/v1/pair/status/${encodeURIComponent(offerNonce)}`)) as PairStatus;
    if (status.sas || status.stage === "confirmed" || Date.now() > deadline) return status;
    await delay(POLL_INTERVAL_MS);
  }
}

async function forwardConfirm(dirs: Dirs, target: PairTarget, offerNonce: string): Promise<void> {
  const result = (await apiFetch(dirs, `/v1/pair/local-confirm/${encodeURIComponent(offerNonce)}`, {
    method: "POST",
  })) as { confirm: PairConfirmSig };
  const res = await remoteJson(target, `/v1/pair/confirm/${encodeURIComponent(offerNonce)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result.confirm),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`remote confirm failed: ${res.status}`);
  }
}

/**
 * amail pair <user@device> [--host --port] [--confirm]：
 * 缺省 --host/--port 时经 mDNS 发现解析；按对端状态自动发起（local-offer → 转发 offer）
 * 或应答（pending offer → local-answer → 转发 answer），展示 6 位 SAS；
 * --confirm 后各自提交 PairConfirmSig，双签齐即完成配对。
 */
export async function runPair(address: string, options: PairOptions = {}): Promise<PairStatus> {
  if ((options.host === undefined) !== (options.port === undefined)) {
    throw new Error("--host and --port must be given together");
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port <= 0)) {
    throw new Error("--port must be a positive integer");
  }
  const dirs = resolveDirs(options.env ?? process.env);
  // 显式参数优先（同机多实例）；缺省时按需经 mDNS 解析（复用会话的路径无需再解析）
  let target: PairTarget | undefined =
    options.host !== undefined && options.port !== undefined
      ? { host: options.host, port: options.port }
      : undefined;
  const targetFor = async (): Promise<PairTarget> => (target ??= await resolveTarget(dirs, address));

  // 会话复用优先级：
  // 1. 本机发起且已 answer → 显示/复用该 SAS（普通重跑与 --confirm 都不新建 offer）
  // 2. 远端 offer 待应答 → 应答模式
  // 3. --confirm 但无可复用会话 → 报错（绝不新建 offer）
  // 4. 本机发起但尚未 answer → 提示等待对端（保留原会话，不新建 offer）
  const pending = (await apiFetch(dirs, "/v1/pair/pending")) as PendingOffer[];
  const localSession = pending.find((p) => p.local && p.user === address);
  const toConfirm = options.confirm && localSession?.stage === "answered" ? localSession : undefined;
  const toAnswer = pending.find((p) => !p.local && p.user === address);

  let offerNonce: string;
  if (toConfirm) {
    offerNonce = toConfirm.offerNonce;
  } else if (!options.confirm && localSession?.stage === "answered") {
    const status = (await apiFetch(
      dirs,
      `/v1/pair/status/${encodeURIComponent(localSession.offerNonce)}`,
    )) as PairStatus;
    console.log(`SAS: ${status.sas}（与对端比对，一致后 amail pair --confirm）`);
    return status;
  } else if (toAnswer) {
    const result = (await apiFetch(dirs, `/v1/pair/local-answer/${encodeURIComponent(toAnswer.offerNonce)}`, {
      method: "POST",
    })) as { answer: PairAnswer; sas: string };
    offerNonce = toAnswer.offerNonce;
    const res = await remoteJson(await targetFor(), `/v1/pair/answer/${encodeURIComponent(offerNonce)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result.answer),
    });
    if (!res.ok) throw new Error(`remote answer failed: ${res.status}`);
    console.log(`SAS: ${result.sas}（与对端比对，一致后 amail pair --confirm）`);
  } else if (options.confirm) {
    // --confirm 只推进已显示 SAS 的会话；无会话可复用时不得新建 offer（否则原会话断链）
    if (localSession) {
      throw new Error(
        `pairing session with ${address} is not answered yet — wait for the peer to answer, then rerun \`amail pair ${address} --confirm\``,
      );
    }
    throw new Error(
      `no pending pairing session with ${address} — run \`amail pair ${address}\` first`,
    );
  } else if (localSession) {
    // 发起方重跑普通 pair：已有会话（仅 offer）→ 提示等待对端，保留原会话
    const status = (await apiFetch(
      dirs,
      `/v1/pair/status/${encodeURIComponent(localSession.offerNonce)}`,
    )) as PairStatus;
    console.log(`已向 ${address} 发起配对，等待对端应答…（复用会话 ${localSession.offerNonce}）`);
    if (status.sas) console.log(`SAS: ${status.sas}（与对端比对，一致后 amail pair --confirm）`);
    return status;
  } else {
    // 先解析对端（发现失败即报错，不留本机幽灵 offer）
    const remote = await targetFor();
    const { offer } = (await apiFetch(dirs, "/v1/pair/local-offer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: address }),
    })) as {
      offer: PairOffer;
    };
    offerNonce = offer.nonce;
    const res = await remoteJson(remote, "/v1/pair/offer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(offer),
    });
    if (!res.ok) throw new Error(`remote offer failed: ${res.status}`);
    const status = await pollStatus(dirs, offerNonce);
    if (status.sas) console.log(`SAS: ${status.sas}（与对端比对，一致后 amail pair --confirm）`);
    else throw new Error("pairing timed out waiting for answer");
  }

  if (!options.confirm) {
    return (await apiFetch(dirs, `/v1/pair/status/${encodeURIComponent(offerNonce)}`)) as PairStatus;
  }
  await forwardConfirm(dirs, await targetFor(), offerNonce);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const status = (await apiFetch(dirs, `/v1/pair/status/${encodeURIComponent(offerNonce)}`)) as PairStatus;
    if (status.stage === "confirmed" || Date.now() > deadline) {
      if (status.stage === "confirmed") console.log(`已配对：${status.peer}`);
      return status;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** amail unpair <addr>：吊销对端（拒收其后续直投） */
export async function runUnpair(address: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  const dirs = resolveDirs(options.env ?? process.env);
  const result = (await apiFetch(dirs, "/v1/peers/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addr: address }),
  })) as { revoked: boolean };
  console.log(result.revoked ? `已解绑 ${address}` : `${address} 不在已配对列表`);
  return result.revoked;
}

export default function register(program: Command): void {
  program
    .command("pair")
    .description("pair with a LAN peer (offer/answer/SAS/confirm)")
    .argument("<address>", "peer address user@device")
    .option("--host <host>", "peer daemon host (default: resolve via mDNS)")
    .option("--port <port>", "peer daemon port (default: resolve via mDNS)", Number)
    .option("--confirm", "submit confirmation signature after SAS match")
    .action(async (address: string, opts: { host?: string; port?: number; confirm?: boolean }) => {
      await runPair(address, opts);
    });
  program
    .command("unpair")
    .description("revoke a paired peer")
    .argument("<address>", "peer address user@device")
    .action(async (address: string) => {
      await runUnpair(address);
    });
}

import type { Command } from "commander";
import { resolveDirs, type Dirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";
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
  user: string;
  deviceId: string;
}

interface PairStatus {
  stage: "offer" | "answered" | "confirmed";
  sas: string | null;
  peer: string | null;
}

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 5_000;

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
 * amail pair <user@device> --host --port [--confirm]：
 * 按对端状态自动发起（local-offer → 转发 offer）或应答（pending offer → local-answer → 转发 answer），
 * 展示 6 位 SAS；--confirm 后各自提交 PairConfirmSig，双签齐即完成配对。
 */
export async function runPair(address: string, options: PairOptions = {}): Promise<PairStatus> {
  if (!options.host || !options.port) {
    throw new Error("--host and --port are required (see `amail peers --scan`)");
  }
  const dirs = resolveDirs(options.env ?? process.env);
  const target: PairTarget = { host: options.host, port: options.port };

  // 应答模式：本机守护进程有来自对端的待应答 offer
  const pending = (await apiFetch(dirs, "/v1/pair/pending")) as PendingOffer[];
  const toAnswer = pending.find((p) => p.user === address);

  let offerNonce: string;
  if (toAnswer) {
    const result = (await apiFetch(dirs, `/v1/pair/local-answer/${encodeURIComponent(toAnswer.offerNonce)}`, {
      method: "POST",
    })) as { answer: PairAnswer; sas: string };
    offerNonce = toAnswer.offerNonce;
    const res = await remoteJson(target, `/v1/pair/answer/${encodeURIComponent(offerNonce)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result.answer),
    });
    if (!res.ok) throw new Error(`remote answer failed: ${res.status}`);
    console.log(`SAS: ${result.sas}（与对端比对，一致后 amail pair --confirm）`);
  } else {
    const { offer } = (await apiFetch(dirs, "/v1/pair/local-offer", { method: "POST" })) as {
      offer: PairOffer;
    };
    offerNonce = offer.nonce;
    const res = await remoteJson(target, "/v1/pair/offer", {
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
  await forwardConfirm(dirs, target, offerNonce);
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
    .requiredOption("--host <host>", "peer daemon host")
    .requiredOption("--port <port>", "peer daemon port", Number)
    .option("--confirm", "submit confirmation signature after SAS match")
    .action(async (address: string, opts: { host: string; port: number; confirm?: boolean }) => {
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

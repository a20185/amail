import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { DAEMON_VERSION, userAddress } from "./server.js";
import { loadOrCreateIdentity } from "../core/identity.js";
import type { Dirs } from "../core/paths.js";

export const AMAIL_SERVICE = "_amail._tcp";

export interface PeerAdvertisement {
  name: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

export interface AdvertiseHandle {
  end(): Promise<void>;
}

export interface AdvertiseService {
  name: string;
  type: string;
  protocol: "tcp";
  port: number;
  txt: Record<string, string>;
}

/**
 * mDNS responder：广播 + 浏览的唯一底座。
 * 生产实现走 ciao（广播）/ dgram 查询（浏览）；测试注入 fake 后不发任何真组播，
 * 广播写入的内存注册表可被同一 responder 的 browse 读到（发现链路全走生产代码）。
 */
export interface MdnsResponder {
  advertise(service: AdvertiseService): Promise<AdvertiseHandle>;
  browse(timeoutMs: number): Promise<PeerAdvertisement[]>;
  /** 取消路径：广播超时/停机时尽力关闭底层 responder */
  shutdown?(): Promise<void>;
}

/** 广播超时（ciao 探测失败会无限递归重试，不得阻塞 daemon 启动） */
export const ADVERTISE_TIMEOUT_MS = 3_000;

export class AdvertiseTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`mDNS advertise timed out after ${timeoutMs}ms`);
    this.name = "AdvertiseTimeoutError";
  }
}

export interface MdnsDeps {
  /** 注入 fake responder（测试）；缺省真发/真查组播 */
  responder?: MdnsResponder;
  /** 注入 ciao 模块加载器（测试引用计数语义）；缺省运行时动态 import 可选依赖 */
  loadCiao?: () => Promise<CiaoLike>;
  /** 广播超时覆盖（测试注入短值） */
  advertiseTimeoutMs?: number;
}

/** ciao service 最小接口（advertise 探测完成 / end 撤销） */
export interface CiaoServiceLike {
  advertise(): Promise<void>;
  end(): Promise<void>;
}

/** ciao responder 最小接口：单例由 getResponder() 取，引用计数由 shutdown() 递减 */
export interface CiaoResponderLike {
  createService(service: AdvertiseService): CiaoServiceLike;
  shutdown(): Promise<void>;
}

export interface CiaoLike {
  getResponder(): CiaoResponderLike;
}

/**
 * 测试用 fake responder：不发组播，仅维护内存注册表。
 * browse 返回 host=127.0.0.1（进程内 daemon 均在回环可达）。
 */
export function createFakeResponder(): MdnsResponder & { shutdownCount(): number } {
  const registry = new Map<string, PeerAdvertisement>();
  let shutdowns = 0;
  return {
    async advertise(service) {
      registry.set(service.name, {
        name: service.name,
        host: "127.0.0.1",
        port: service.port,
        txt: { ...service.txt },
      });
      return {
        async end() {
          registry.delete(service.name);
        },
      };
    },
    async browse() {
      return [...registry.values()];
    },
    async shutdown() {
      shutdowns += 1;
      registry.clear();
    },
    shutdownCount() {
      return shutdowns;
    },
  };
}

/** 动态加载 ciao（可选运行时依赖，仅真广播时加载） */
const loadCiao: () => Promise<CiaoLike> = async () =>
  (await import("@homebridge/ciao")) as unknown as CiaoLike;

/**
 * 测试专用故障注入（AMAIL_MDNS_FAKE=always-fail）：广告永不完成，并像 ciao 1.3.12
 * 探测退避循环那样留下一个无 unref、不可取消的 ref 定时器——复现"泄漏定时器阻止进程退出"。
 */
function faultInjectionResponder(env: NodeJS.ProcessEnv): MdnsResponder | undefined {
  if (env.AMAIL_MDNS_FAKE !== "always-fail") return undefined;
  const retry = setInterval(() => {}, 2_000); // 有意不 unref：模拟 ciao 退避重试
  return {
    advertise: () =>
      new Promise<AdvertiseHandle>(() => {
        void retry;
      }),
    browse: async () => [],
  };
}

/**
 * ciao responder 包装：首次 advertise 取得的单例实例被记住，取消/停机对**同一实例**
 * shutdown（引用计数 1→0 才真正关闭）。超时后若广播迟到完成，其 handle.end 不再重复减计数。
 */
function createCiaoResponder(load: () => Promise<CiaoLike> = loadCiao): MdnsResponder {
  let instance: CiaoResponderLike | undefined;
  let released: CiaoResponderLike | undefined;

  async function shutdown(): Promise<void> {
    const current = instance;
    instance = undefined;
    released = current;
    await current?.shutdown();
  }

  return {
    async advertise(service) {
      const ciao = await load();
      const responder = (instance ??= ciao.getResponder());
      const advertised = responder.createService(service);
      await advertised.advertise();
      return {
        async end() {
          await advertised.end();
          if (released === responder) return; // 取消路径已关闭同一实例，勿重复 shutdown
          await shutdown();
        },
      };
    },
    browse: browseWithDgram,
    shutdown,
  };
}

/** mDNS 广播：_amail._tcp，TXT {fp, user, ver}；超时即失败（调用方降级继续，不得阻塞启动） */
export async function advertise(dirs: Dirs, port: number, deps: MdnsDeps = {}): Promise<AdvertiseHandle> {
  const identity = loadOrCreateIdentity(dirs);
  const service: AdvertiseService = {
    name: `amail-${identity.deviceId}`,
    type: "amail",
    protocol: "tcp",
    port,
    txt: {
      fp: identity.deviceId,
      user: userAddress(dirs, identity),
      ver: DAEMON_VERSION,
    },
  };
  const responder =
    deps.responder ?? faultInjectionResponder(process.env) ?? createCiaoResponder(deps.loadCiao);
  const timeoutMs = deps.advertiseTimeoutMs ?? ADVERTISE_TIMEOUT_MS;
  const pending = responder.advertise(service);
  const { promise: timeout, reject: onTimeout } = Promise.withResolvers<never>();
  const timer = setTimeout(() => onTimeout(new AdvertiseTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    if (err instanceof AdvertiseTimeoutError) {
      // 取消路径：迟到的广播成功立即撤销；底层 responder 尽力关闭。
      // 注意 ciao 1.3.12 探测失败时清空 currentProber 并每 2s 递归重试，定时器无 unref、
      // 外部无法取消，shutdown() 也停不掉它——进程终止靠 daemon 终止路径的显式 process.exit
      // 兜底（见 cli/cmds/daemon.ts）；升级 ciao 后需复核此假设。
      void pending.then((handle) => handle.end()).catch(() => {});
      void responder.shutdown?.().catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 广播失败后台重试的退避序列（毫秒）：10s → 30s → 60s → 120s → 300s 封顶 */
export const ADVERTISE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

/** 定时器 seam：测试注入手动时钟，不真等退避时长 */
export interface RetryClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultRetryClock: RetryClock = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface RetryAdvertiseOptions extends MdnsDeps {
  /** 退避序列覆盖（测试注入毫秒级序列） */
  delaysMs?: readonly number[];
  /** 定时器注入（测试用手动时钟） */
  clock?: RetryClock;
  /** 重试成功时交付广播句柄（调用方负责停机撤销） */
  onAdvertised: (handle: AdvertiseHandle) => void;
}

export interface AdvertiseRetry {
  /** 取消待定重试；在途尝试收尾（迟到成功立即撤销，不再重试） */
  stop(): Promise<void>;
}

/**
 * mDNS 广播后台重试：首次 advertise 失败后按退避序列反复重试，直到成功或 stop()。
 * 每次重试都走既有 advertise 路径（含超时/取消语义）；期间守护进程正常服务。
 */
export function retryAdvertise(
  dirs: Dirs,
  port: number,
  options: RetryAdvertiseOptions,
): AdvertiseRetry {
  const delays = options.delaysMs ?? ADVERTISE_RETRY_DELAYS_MS;
  const clock = options.clock ?? defaultRetryClock;
  let stopped = false;
  let timer: unknown;
  let inflight: Promise<void> | undefined;

  const schedule = (attempt: number): void => {
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    timer = clock.setTimeout(() => {
      timer = undefined;
      attemptOnce(attempt + 1);
    }, delay);
  };

  const attemptOnce = (attempt: number): void => {
    const run = (async (): Promise<void> => {
      try {
        const advertised = await advertise(dirs, port, options);
        if (stopped) {
          // 停机竞态：迟到成功的广播立即撤销，避免局域网残留幽灵实例
          await advertised.end().catch(() => {});
          return;
        }
        options.onAdvertised(advertised);
        console.warn(`[amail] mDNS advertise recovered after ${attempt} retry attempt(s)`);
      } catch (err) {
        if (stopped) return;
        // 首次失败由 startDaemon 告警；重试失败仅 debug，避免退避期间刷屏
        console.debug(`[amail] mDNS advertise retry ${attempt} failed: ${(err as Error).message}`);
        schedule(attempt);
      }
    })();
    inflight = run;
    void run.then(() => {
      if (inflight === run) inflight = undefined;
    });
  };

  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      await inflight;
    },
  };
}

// ---- 最小 mDNS 查询器（legacy unicast：源端口非 5353，id 非 0） ----

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  const bufs = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "latin1")]));
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function buildQuery(id: number, questions: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0, 2); // 标准 query
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([
    header,
    ...questions.map((q) =>
      Buffer.concat([encodeName(q), Buffer.from([0x00, 0x0c, 0x00, 0x01])]), // QTYPE=PTR QCLASS=IN
    ),
  ]);
}

function readName(buf: Buffer, offset: number): { name: string; offset: number } {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let end = pos;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf.readUInt8(pos);
    if (len === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf.readUInt8(pos + 1);
      if (!jumped) end = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString("latin1", pos + 1, pos + 1 + len));
    pos += 1 + len;
    if (!jumped) end = pos;
  }
  return { name: labels.join("."), offset: end };
}

function parseTxt(rdata: Buffer): Record<string, string> {
  const txt: Record<string, string> = {};
  let pos = 0;
  while (pos < rdata.length) {
    const len = rdata.readUInt8(pos);
    const entry = rdata.toString("latin1", pos + 1, pos + 1 + len);
    const eq = entry.indexOf("=");
    if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
    pos += 1 + len;
  }
  return txt;
}

export interface SrvRecord {
  target: string;
  port: number;
}

/**
 * 解析 mDNS 应答包，提取 _amail._tcp 实例的 SRV/TXT。
 * SRV RDATA = priority(2) weight(2) port(2) target —— port 读偏移 4。
 */
export function parseResponse(buf: Buffer): Array<{ name: string; srv?: SrvRecord; txt?: Record<string, string> }> {
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ar = buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const q = readName(buf, pos);
    pos = q.offset + 4;
  }
  const out = new Map<string, { name: string; srv?: SrvRecord; txt?: Record<string, string> }>();
  const total = an + ar;
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const parsed = readName(buf, pos);
    pos = parsed.offset;
    const type = buf.readUInt16BE(pos);
    pos += 8; // type(2) class(2) ttl(4)
    const rdlen = buf.readUInt16BE(pos);
    pos += 2;
    const rdata = buf.subarray(pos, pos + rdlen);
    if (type === 33) {
      // SRV
      const target = readName(rdata, 6);
      const entry = out.get(parsed.name) ?? { name: parsed.name };
      entry.srv = { target: target.name, port: rdata.readUInt16BE(4) };
      out.set(parsed.name, entry);
    } else if (type === 16) {
      // TXT
      const entry = out.get(parsed.name) ?? { name: parsed.name };
      entry.txt = parseTxt(rdata);
      out.set(parsed.name, entry);
    }
    pos += rdlen;
  }
  return [...out.values()];
}

/** 挑选 browse 使用的非内网 IPv4 接口地址（多网卡/VPN 主机逐接口 join+发送；排除回环） */
export function pickBrowseInterfaces(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const infos of Object.values(ifaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      const fam = info.family as string | number;
      if (fam !== "IPv4" && fam !== 4) continue;
      out.push(info.address);
    }
  }
  return [...new Set(out)];
}

async function browseWithDgram(timeoutMs: number): Promise<PeerAdvertisement[]> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const found = new Map<string, PeerAdvertisement>();
  const { promise, resolve } = Promise.withResolvers<PeerAdvertisement[]>();

  socket.on("message", (msg) => {
    try {
      for (const rec of parseResponse(msg)) {
        if (!rec.srv) continue;
        found.set(rec.name, {
          name: rec.name,
          host: rec.srv.target,
          port: rec.srv.port,
          txt: rec.txt ?? {},
        });
      }
    } catch {
      // 忽略畸形包
    }
  });
  socket.on("error", () => resolve([...found.values()]));

  const { promise: bound, resolve: onBound } = Promise.withResolvers<void>();
  socket.bind(() => onBound());
  await bound;

  // 多网卡/VPN 主机：逐接口 join 组播组并按接口发送查询（默认路由可能落在 VPN/tunnel 上）
  const query = buildQuery(1, [`${AMAIL_SERVICE}.local`]);
  const ifaces = pickBrowseInterfaces();
  for (const addr of ifaces) {
    try {
      socket.addMembership(MDNS_GROUP, addr);
    } catch {
      // 接口不支持组播时跳过
    }
  }
  for (const addr of ifaces) {
    try {
      socket.setMulticastInterface(addr);
      socket.send(query, MDNS_PORT, MDNS_GROUP, () => {
        // 发送失败也等待超时窗口
      });
    } catch {
      // 单接口失败不影响其他接口
    }
  }
  if (ifaces.length === 0) {
    socket.send(query, MDNS_PORT, MDNS_GROUP, () => {
      // 无可用接口时退回默认路由，失败也等待超时窗口
    });
  }

  setTimeout(() => {
    socket.close();
    resolve([...found.values()]);
  }, timeoutMs);
  return promise;
}

/** 浏览局域网 amail 对端，收集到 timeoutMs 为止 */
export async function browsePeers(timeoutMs: number, deps: MdnsDeps = {}): Promise<PeerAdvertisement[]> {
  const responder = deps.responder ?? createCiaoResponder(deps.loadCiao);
  return responder.browse(timeoutMs);
}

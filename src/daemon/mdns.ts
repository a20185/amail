import { createSocket } from "node:dgram";
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
  /** 广播超时覆盖（测试注入短值） */
  advertiseTimeoutMs?: number;
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


async function ciaoAdvertise(service: AdvertiseService): Promise<AdvertiseHandle> {
  const { getResponder } = await import("@homebridge/ciao"); // 运行时可选依赖，仅真广播时加载
  const responder = getResponder();
  const advertised = responder.createService({
    name: service.name,
    type: service.type,
    port: service.port,
    txt: service.txt,
  });
  await advertised.advertise();
  return {
    async end() {
      await advertised.end();
      await responder.shutdown();
    },
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
  const responder = deps.responder ?? defaultResponder;
  const timeoutMs = deps.advertiseTimeoutMs ?? ADVERTISE_TIMEOUT_MS;
  const pending = responder.advertise(service);
  const { promise: timeout, reject: onTimeout } = Promise.withResolvers<never>();
  const timer = setTimeout(() => onTimeout(new AdvertiseTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    if (err instanceof AdvertiseTimeoutError) {
      // 取消路径：迟到的广播成功立即撤销；底层 responder 尽力关闭（ciao 的重试循环随之终止）
      void pending.then((handle) => handle.end()).catch(() => {});
      void responder.shutdown?.().catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  socket.send(buildQuery(1, [`${AMAIL_SERVICE}.local`]), MDNS_PORT, MDNS_GROUP, () => {
    // 发送失败也等待超时窗口
  });

  setTimeout(() => {
    socket.close();
    resolve([...found.values()]);
  }, timeoutMs);
  return promise;
}

/** 生产 responder：ciao 广播 + dgram 浏览 */
const defaultResponder: MdnsResponder = {
  advertise: ciaoAdvertise,
  browse: browseWithDgram,
  async shutdown() {
    try {
      const { getResponder } = await import("@homebridge/ciao");
      await getResponder().shutdown();
    } catch {
      // 可选依赖缺失或已关闭：取消路径尽力而为
    }
  },
};

/** 浏览局域网 amail 对端，收集到 timeoutMs 为止 */
export async function browsePeers(timeoutMs: number, deps: MdnsDeps = {}): Promise<PeerAdvertisement[]> {
  const responder = deps.responder ?? defaultResponder;
  return responder.browse(timeoutMs);
}

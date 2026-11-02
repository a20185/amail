#!/usr/bin/env node
/**
 * 双机 smoke 助手：以本机设备身份签名拉取工作区镜像快照（mirror 读取暂无 CLI 命令）。
 *
 * 用法（在被测仓库根目录执行；需先 pnpm build）：
 *   WS_ID=ws_xxx SESSION_ID=<sessionId> A_HOST=192.168.1.10:36969 \
 *   MY_ADDR=bob@hostb node scripts/smoke/signed-snapshot.mjs
 *
 * 环境变量：
 *   WS_ID       工作区 id（amail ws list 获取）
 *   SESSION_ID  attach 的会话 id（amail attach --list 获取）
 *   A_HOST      房主 daemon 地址 host:port
 *   MY_ADDR     本机完整地址（user@device，签名方）
 *   AMAIL_HOME  可选；缺省按 ~/.config 规则解析
 *
 * 成功输出 status 200 + JSON；非 200 退出码 1。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);
const load = (rel) => import(pathToFileURL(resolve(root, "dist", rel)).href);

const { WS_ID, SESSION_ID, A_HOST, MY_ADDR } = process.env;
if (!WS_ID || !SESSION_ID || !A_HOST || !MY_ADDR) {
  console.error("缺少环境变量：WS_ID / SESSION_ID / A_HOST / MY_ADDR");
  process.exit(2);
}

const [{ loadOrCreateIdentity }, { deviceSignMessage, requestSigMessage }, { sha256Hex }, { resolveDirs }] =
  await Promise.all([
    load("core/identity.js"),
    load("workspace/projection-local.js"),
    load("core/crypto.js"),
    load("core/paths.js"),
  ]);

const dirs = resolveDirs(process.env);
const id = loadOrCreateIdentity(dirs);

const path = `/ws/${WS_ID}/mirror/${SESSION_ID}/snapshot`;
const date = new Date().toISOString();
const sig = deviceSignMessage(id.signPrivPem, requestSigMessage("GET", path, sha256Hex(""), date));

let res;
try {
  res = await fetch(`http://${A_HOST}${path}`, {
    headers: { "X-Amail-Sig": sig, "X-Amail-Date": date, "X-Amail-Actor": MY_ADDR },
  });
} catch (e) {
  console.error(`无法连接房主 daemon（${A_HOST}）：${e.message}`);
  process.exit(1);
}

const text = await res.text();
console.log("status", res.status);
console.log(text.slice(0, 4000));
process.exit(res.status === 200 ? 0 : 1);

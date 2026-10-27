# 开源调研与依赖健康审计

日期：2026-10-27。方法：四条检索 lane（agent 协议 / P2P 传输 / LAN 发现 / 消息先例）→ 候选裁决；再对「薄自研核心」实际依赖短名单拉 GitHub 仓库指标 + npm registry 下载量与发布新鲜度 + 本机 Node v24.15.0 能力实测。所有数字为当日抓取。

## 1. 候选裁决

| 候选 | 是什么 | 许可 / 成熟度 | 裁决 |
|---|---|---|---|
| agentmbx | 同题最全：签名信箱 + 每机守护进程 + mDNS + 配对令牌 + 线程/回执/FTS5 + 空闲唤醒 + relay | BUSL-1.1（非开源），alpha，1 star，单作者，Node 24 | **adapt**——设计蓝本（配对、出箱重试、密封正文），不作基座（ADR-0001） |
| agent-mail-cli | 本机信箱 CLI；「消息是协调不是内容」（正文 ≤2000 字、实质走文件引用）、`describe` 自描述、`watch` 阻塞、`next` 指令引导 | MIT，Python，单机无网络 | **adapt**——信件工效学与 skill 引导设计 |
| agent-inbox (PyPI) | SQLite 信箱 + HTTP API + ActivityStreams + stdio MCP | Python，本机 | skip |
| agent-mailbox-mcp / agenticmail | SQS 式队列 / 托管真邮件基础设施 | — | skip（语义相反） |
| A2A（含 ACP 合并，Linux 基金会，v0.3.x） | 不透明 agent 间 RPC/任务协议 | Apache-2.0 | skip（RPC 语义非信箱；信封设计可参考） |
| @number0/iroh | iroh 1.0 官方 Node 绑定：直连+打洞+relay | MIT/Apache-2.0，上游 12.8k stars | 备选：跨网阶段传输层 |
| hyperswarm / libp2p | 纯 JS DHT 组网 / 模块化 P2P 栈 | 可用但 LAN 场景 DHT 过重 | skip |
| SSB / Bitmessage | 离线优先 gossip / 存储转发邮件 | 社区萎缩 | skip（思想已吸收：签名 feed、出箱） |

## 2. 依赖健康审计（实际会用的短名单）

| 依赖 | 30d 下载 | Stars | 最近推送 | 许可 | 结论 |
|---|---|---|---|---|---|
| @homebridge/ciao | 15,121,136 | 97 | 2026-10-26 | MIT | **adopt**（星数低因属 homebridge 生态；月分发 1500 万，当日有提交） |
| ws | 948,707,300 | 22,812 | 2026-10-23 | MIT | 备而未用（SSE 零依赖替代 ws） |
| commander | 1,892,297,232 | 28,438 | 2026-10-26 | MIT | **adopt**（CLI 骨架） |
| node:crypto + node:sqlite | 内置 | — | — | 内置 | **adopt**（零第三方依赖） |
| @number0/iroh | 6,535 | 12,835（本体） | 2026-10-26 | MIT/Apache-2.0 | 跨网阶段再启 |
| multicast-dns | 72,946,143 | 532 | 2024-06 仓停更 | MIT | skip |
| bonjour | 11,724,509 | 仓库失联 | — | MIT | skip（被 ciao 取代） |
| better-sqlite3 | 31,769,221 | — | 2026-08 | MIT | skip（原生编译分发面大） |

## 3. 本机实测记录

Node v24.15.0：

- Ed25519 sign/verify ✓；X25519 ECDH 32B ✓；AES-256-GCM ✓；HKDF ✓（全部 node:crypto 内置）
- node:sqlite（SQLite 3.51.3）：FTS5 ✓；`trigram` 分词器中文 **≥3 字**子串命中（「契约门」✓），2 字词（「结算」）不命中——trigram 需 ≥3 字符；`unicode61` 默认分词对中文完全无效。设计取 trigram + 短词 LIKE 兜底。

npm 名（registry API 实测）：

- `amail` 已占用（占位包，无有效版本描述）；`agentmail` 已占用（另一项目：托管邮件 API）
- **`agent-mail` 可用**（选定）；`@amail/cli` 未占用但 scope 归属需人工确认（npmjs.com 网页反爬 403，无法程序化核实 org 是否已被注册）

## 4. 结论

无现成 OSI 开源项目覆盖「用户级身份 + LAN P2P + 信箱语义 + agent skills」全组合；走薄自研核心 + 上述 MIT 组件，直接运行时依赖仅 ciao 与 commander，Node 基线 ≥ 24。

## 5. 工作区第二轮调研（2026-10-27）

| 先例 | 是什么 | 许可 / 规模 | 裁决 |
|---|---|---|---|
| Multica | 人 + agent 混编团队的共享项目空间：issue + 执行日志回放 + diff + steering + inbox，26 个 agent CLI（含 Pi） | **License: Other（source-available 非 OSI）**，54.0k★ | 概念样板（该类目最强），不可作基座（同 agentmbx 的许可坑） |
| Backlog.md | markdown + git 任务管理，三道评审检查点 | MIT，7.2k★ | **adapt**：todo 形态蓝本、导出兼容 |
| happy | 包装 CLI + E2EE relay + 多人共看 / 驾驶 session | MIT，24.3k★ | **adapt**：session 镜像可行性证明；relay → LAN P2P |
| vibe-kanban | 看板 + worktree 编排执行 agent | Apache-2.0，28.5k★，**sunset 中** | skip（重一个量级且停摆） |
| Huly / Plane | 开源 Linear+Slack+Notion 全家桶 | AGPL-3.0 | skip（中心服务栈，与 P2P 形态冲突） |
| Yjs / Automerge | CRDT 共享数据类型 | MIT | skip（低频结构化写零收益） |

结论：业界"统一方案"存在（Multica / Huly / Plane / Linear+MCP）但**全部中心化**（云或自托管栈），无 P2P / LAN 形态。工作区按件取材：todo ← Backlog.md 形态、session 镜像 ← happy、统一承载 = 房主权威事件协议（ADR-0002）。

# agent-mail 实施计划（Phase 0–8，对应设计全案 M0–M8）

- 基线分支：`feat/v0-impl`（自 `main@ddd94da` 切出；本仓无 origin，上游检查 N/A）
- 执行管线：subagent-dev-simple（逐阶段 implementer，无逐段评审）→ 全阶段完成后 codex-review-loop（impl-mode）作质量门
- 计划高度：本文件只含意图、文件边界、契约形状、验收规则；无代码体，不留实现者设计选择
- review BASE：`ddd94da`（Phase 0 前一提交）

## 全局约束（所有阶段遵守）

1. Node ≥ 24（`engines`），ESM（`"type":"module"`），TypeScript strict，构建仅 `tsc`，测试 vitest，包管理 pnpm。
2. 依赖白名单（Phase 0 一次性声明，后续阶段不得改 package.json）：运行时 `zod`、`commander`、`@homebridge/ciao`、`ulid`；开发 `typescript`、`vitest`、`@types/node`。加密/存储用 `node:crypto`/`node:sqlite`，禁止引入其他运行时依赖。
3. **注册表模式**（为文件所有权隔离而设，P2/P3 落地后 P4–P8 只新增文件）：
   - daemon 路由自动发现：启动时扫描编译产物 `dist/daemon/routes/*.js`，动态 import，每个模块默认导出 `{path, method, lan: boolean, handler}`；`lan:false` 的路由源地址非 127.0.0.1 时 403。
   - CLI 子命令自动发现：`src/cli/main.ts` 扫描 `dist/cli/cmds/*.js`，每模块导出 `register(program)`。
   - skill 安装整包复制：`amail skill install` 复制包内 `skills/` 下**每个**技能目录到目标目录（P5 只带 amail，P8 新增 amail-ws 无需改代码）。
4. 每阶段 TDD：先写失败测试再实现；`pnpm test && pnpm typecheck && pnpm build` 全绿才可提交。
5. 提交信息：`feat(phase-N): <阶段名>`，单阶段单提交。
6. 测试不得依赖真实网络与真实 `~/.claude`、`~/.pi`、`~/.local/share/opencode`：用 env 覆盖（`AMAIL_HOME`）与 fixture 文件。
7. 与设计全案的四处已裁定偏差（见 §验收）：skill 显式安装命令、双 skill 文件、Claude Code 适配器仅 JSONL tail、M4 真机 e2e 以进程内双 daemon 测试替代。

## 目录与文件所有权矩阵

| 路径 | 建阶段 |
|---|---|
| package.json / tsconfig.json / vitest.config.ts / src/contract/* | P0 |
| src/core/{paths,db,identity,crypto,store,outbox}.ts | P1 |
| src/daemon/{router,server,sse,mdns,notify}.ts、src/daemon/routes/{alive,inbox,send-local}.ts | P2 |
| src/cli/main.ts、src/cli/cmds/{setup,daemon,identity,project,inbox,read,archive,watch}.ts、src/core/project.ts | P3 |
| src/core/{peer,delivery}.ts、src/daemon/routes/{deliver,receipt,pair}.ts、src/cli/cmds/{peers,pair,send,reply,status}.ts | P4 |
| src/cli/cmds/{handoff,skill}.ts、skills/amail/SKILL.md | P5 |
| src/workspace/{events,host,projection-local,invite}.ts、src/daemon/routes/workspace.ts、src/cli/cmds/ws.ts | P6 |
| src/mirror/{types,claude-code,pi,opencode,hub}.ts、src/daemon/routes/mirror.ts、src/cli/cmds/attach.ts | P7 |
| src/workspace/artifacts.ts、src/daemon/routes/ws-artifacts.ts、src/cli/cmds/artifact.ts、skills/amail-ws/SKILL.md、README.md | P8 |

无任何文件出现在两个阶段（README.md 仅 P8 修改）。

## 共享契约速查（各阶段引用，字段为准）

- **地址**：`user@device`；zod `AddressSchema` + `parseAddress`（无 @ 或空段拒绝）。
- **信封 envelope v1**（P0 定形，全链路唯一）：`{v:1, id:"msg_"+ULID, from, to, subject, inReplyTo:string|null, references:string[], createdAt:ISO8601, claim:{name,email}, seal:{alg:"x25519-aes256gcm", epk:b64, iv:b64(12B), body:b64}, attachments:[{id:"att_"+ULID, name, sha256:hex64, size:number}], sig:b64}`。`sig` 覆盖除 `sig` 外全部字段的规范 JSON 串（键序按 zod 声明序）。密封体 = `{body:string, handoff?:{progress,description,questions[]}, attachmentIds:string[]}`。
- **回执**：`{messageId, kind:"delivered"|"read", at, sig}`（sig 为发方设备签名）。
- **工作区事件**：`{seq:number, actor:地址, kind, payload, at, sig(提交设备)}`；payload 见 P6。
- **路径**：`AMAIL_HOME` env 优先；否则 `~/.config` 存在 → config `~/.config/amail/`、data `~/.local/share/amail/`；否则统一 `~/.amail/`。

<!-- PHASE-0-START -->
## Phase 0 — 契约与脚手架（M0）

**Intent**：建立可编译可测试的包骨架与全部版本化契约（zod），后续阶段只消费不修改。

**Files**

| 路径 | 操作 |
|---|---|
| package.json / tsconfig.json / vitest.config.ts | Create |
| src/contract/{address,envelope,identity,attachment,receipt,pair,workspace,api,index}.ts | Create |
| src/contract/*.test.ts（逐文件） | Create |

**Contract**

- package.json：name `agent-mail`，version 0.0.1，`"type":"module"`，bin `{amail:"dist/cli/main.js"}`，engines `node>=24`，scripts `{build:"tsc", test:"vitest run", typecheck:"tsc --noEmit"}`，files 含 `dist`、`skills`；依赖按全局约束 2 一次声明齐。
- tsconfig：strict、NodeNext、outDir dist、include src；vitest：environment node、include `src/**/*.test.ts`。
- `address.ts`：`AddressSchema`（`user@device`，两段非空、禁空格与 @）、`parseAddress/formatAddress`。
- `envelope.ts`：`EnvelopeSchema`、`SealedBodySchema`（上表形状）、`canonicalJson(value)`（键序=zod 声明序、无空白）、`HandoffSchema{progress:string≤2000, description:string≤4000, questions:string[]1..10}`、信封级校验：`attachments[].size ≥ 0`、`references` 含 `inReplyTo`（若非空）。
- `identity.ts`：`UserClaimSchema{name,email}`、`DeviceIdentitySchema{deviceId(16hex 指纹), deviceName, claim}`、`PeerRecordSchema{deviceId, deviceName, user, device, claim, pubKeyPem, pairedAt, revokedAt:null|ISO}`。
- `attachment.ts`：`AttachmentMetaSchema`（envelope 内形状）+ `ArtifactMetaSchema{artifactId:"art_"+ULID, name, mime, size, note?, tags:string[], sha256}`。
- `receipt.ts`：`ReceiptSchema`（上表形状）。
- `pair.ts`：`PairOfferSchema{deviceId,deviceName,claim,pubKeyPem,nonce}`、`PairAnswerSchema{…同构+offerNonce}`、`PairConfirmSchema{offerSig, answerSig, at}`。
- `workspace.ts`：`WorkspaceEventSchema` + 判别联合 payload：`action{who:地址, content:string≤1000, note?, cc:地址[]}`、`todo{id:"td_"+ULID, title, priority:0|1|2|3, dueRange?{from,to}, status:"todo"|"doing"|"done"|"dropped"}`、`artifact`（=ArtifactMeta）、`membership{op:"add"|"remove", member:地址}`、`session.attach{sessionId, cli:"claude-code"|"pi"|"opencode", cwd, title?}`、`session.detach{sessionId}`。
- `api.ts`：DTO——`AliveInfoSchema{user, deviceName, fingerprint, version, pairedCount}`、`InboxQuerySchema{project?, unread?, all?}`、`SendMessageReqSchema{to, subject, body≤4000, inReplyTo?, refs:string[], handoff?}`、`DeliverResSchema{deliveredAt}`、`WorkspaceSyncQuerySchema{since:number}`、`MirrorEventSchema{t:"msg"|"diff"|"end", sessionId, role?, text?, path?, before?, after?}`。
- 每个测试文件：合法样例 round-trip（parse→canonicalJson→parse 等值）+ ≥3 个非法样例拒绝（字段缺失/类型错/超界）。

**Accept**：`pnpm install && pnpm test && pnpm typecheck && pnpm build` 全绿；`dist/contract/index.js` 存在。

**Commit**：`feat(phase-0): contracts and scaffolding`
<!-- PHASE-0-END -->
<!-- PHASE-1-START -->
## Phase 1 — 核心库：路径/存储/身份/加密/出箱（M1）

**Intent**：无网络的核心能力层：XDG 路径、SQLite 真源（全量 DDL 一次到位）、设备密钥与密封、出箱状态机。

**Files**

| 路径 | 操作 |
|---|---|
| src/core/{paths,db,identity,crypto,store,outbox}.ts | Create |
| src/core/*.test.ts（逐文件） | Create |

**Contract**

- `paths.ts`：`resolveDirs(env)` → `{home, configDir, dataDir, projectsDir, storePath, attachmentsDir, keysDir, peersDir}`；规则=共享契约·路径；自动 mkdir（0700）。
- `db.ts`：`openStore(storePath)` → `DatabaseSync`（WAL、foreign_keys ON）；`migrate(db)` 幂等建表（单版本 schema_version=1）：`messages(id PK, direction'in'|'out', from_addr,to_addr,subject,in_reply_to,thread_root,created_at,received_at,read_at,archived_at,project,body,handoff_json,sig_valid)`、`attachments(id PK,message_id FK,blob_path,…)含 artifact 复用列(name,mime,size,sha256,note,tags_json)`、`receipts(message_id,kind,at)`、`peers(device_id PK,…=PeerRecord 列)`、`outbox(id PK,envelope_json,attempts,next_retry_at,last_error,created_at,expires_at,state'queued'|'delivered'|'expired')`、`workspace_events(seq PK,workspace_id,source'local'|'remote',event_json)`、`workspaces(id PK,name,project_slug,host_addr,created_at)`、`meta(key PK,value)`；FTS5：`messages_fts(body, tokenize='trigram')` + 触发器同步。
- `identity.ts`：`loadOrCreateIdentity(dirs)`（Ed25519 PEM 落 `keys/device.pem` 0600）、`fingerprint(pub)`（sha256 前 16hex）、`deviceName()`（hostname，冲突处理归 mDNS 层）、`buildClaim(name,email)` 签名自声明。
- `crypto.ts`：`sealBody(recipientPubPem, plainBuf)`→Seal（ephemeral X25519 + HKDF 派生 AES-256-GCM 密钥 + 12B iv）、`openBody(privPem, seal)`、`signCanonical(priv, obj)`、`verifyCanonical(pub, obj, sig)`、`sha256Hex(buf)`、`sas6(pubA,pubB)`（sha256(min‖max 规范字节) 前 20bit → 6 位十进制，双方一致）。
- `store.ts`：`saveInbound(db, env, {sigValid})`（事务：message+attachments+fts）、`saveOutbound`、`listInbox(db,{project?,unread?,all?})`（默认=未归档）、`get`/`markRead`/`markArchived(id, project)`、`search(db, q)`（≥3 字走 FTS trigram，否则 LIKE）、`threadOf(id)`（按 thread_root）。
- `outbox.ts`：`enqueue`、`due(db, now)`、`markAttempt(id, err, nextRetry)`（30s 起 ×2 封顶 1h）、`markDelivered`、`expireDue(db, now, 72h)`→过期列表。
- 测试：paths 用 `AMAIL_HOME` 沙箱；db 迁移幂等（跑两次）；crypto round-trip + 篡改密文失败 + sas6 对称；store 中文检索（"契约门"trigram 命中、"结算"LIKE 兜底）；outbox 状态机全转移。

**Accept**：全局约束 4 全绿；上述断言逐一在测试名中出现。

**Commit**：`feat(phase-1): core library — paths, store, identity, crypto, outbox`
<!-- PHASE-1-END -->
<!-- PHASE-2-START -->
## Phase 2 — 守护进程骨架：路由发现/回环面/SSE/mDNS/通知（M2）

**Intent**：常驻服务骨架。LAN 面只有 /alive；回环面信箱读 + 本地发信（入出箱不联网）；事件总线与 SSE；mDNS 广播；桌面通知原语。

**Files**

| 路径 | 操作 |
|---|---|
| src/daemon/{router,server,sse,mdns,notify}.ts | Create |
| src/daemon/routes/{alive,inbox,send-local}.ts | Create |
| 同名 .test.ts | Create |

**Contract**

- `router.ts`：启动扫描 `dist/daemon/routes/*.js` 动态 import；路由形状 `{path, method, lan:boolean, handler(ctx)}`；`ctx={req, res, db, dirs, identity, bus, params, query, body}`；非 lan 路由源 IP ≠127.0.0.1 → 403。
- `server.ts`：`startDaemon({port=36969, dirs})`：单例 pid 锁（`data/daemon.pid`，占用即退出码 3）；SSE `GET /v1/events`（`text/event-stream`，事件 `{type, data}`：new-mail/receipt/outbox/pairing）；优雅停机。端口可注入（测试用 0）。
- `sse.ts`：`EventBus`（on/emit/close-all）。
- `mdns.ts`：`advertise(dirs, port)`（ciao，`_amail._tcp`，TXT `{fp,user,ver}`）；`browsePeers(timeoutMs)` → `[{name, host, port, txt}]`；测试注入 fake 实现（不真发组播）。
- `notify.ts`：`notify(title, body)`：darwin `osascript -e 'display notification …'`；linux `notify-send`；其他平台 no-op；`AMAIL_NOTIFY_CMD` 覆盖（测试用）。
- `routes/alive.ts`：GET /alive，lan=true → `AliveInfo`（peers 计数来自 db）。
- `routes/inbox.ts`：GET `/v1/inbox`（InboxQuery → 列表：id/from/subject/snippet/unread/receivedAt/hasHandoff）、GET `/v1/message/:id`（全文+handoff+附件元数据+blob 路径）、POST `/v1/read` `{id}`（标记+emit receipt 事件）。
- `routes/send-local.ts`：POST `/v1/send`（SendMessageReq）：to 已配对→密封（P1 sealBody，收件人 pub 来自 peers）+签名→saveOutbound+outbox.enqueue+emit outbox；未配对→202 带 `warning:"not-paired"` 且只存草稿不入出箱。返回 `{messageId}`。
- 测试：ephemeral 端口 fetch：非 lan 路由以伪造 remoteAddress 403；/alive 200 形状；send→SSE 收到 outbox 事件；read→receipt 事件。

**Accept**：全局约束 4 全绿；daemon 在随机端口可起可停（测试内）。

**Commit**：`feat(phase-2): daemon skeleton — route discovery, loopback API, SSE, mDNS, notify`
<!-- PHASE-2-END -->
<!-- PHASE-3-START -->
## Phase 3 — CLI 基座与初始化：setup/daemon/project/inbox/read/archive/watch（M3）

**Intent**：`amail` 可安装可初始化：两级初始化（setup + project add）、守护进程前台/安装、本地信箱命令全集。

**Files**

| 路径 | 操作 |
|---|---|
| src/cli/main.ts、src/cli/cmds/{setup,daemon,identity,project,inbox,read,archive,watch}.ts | Create |
| src/core/project.ts | Create |
| 同名 .test.ts | Create |

**Contract**

- `main.ts`：commander + 自动发现 `dist/cli/cmds/*.js`（`register(program)`）；shebang `#!/usr/bin/env node`。
- `setup.ts`：`amail setup [--yes]`：gen 密钥 → 读 `git config --global user.name/user.email`（缺则 `--local`，再缺用占位）→ 交互确认（--yes 跳过）→ 写 claim+config.json（`{version, port:36969, notify:true}`）→ 打印地址与指纹与后续提示（daemon/skill 命令）。幂等：已初始化则只刷新声明。
- `daemon.ts`：`amail daemon [--port]` 前台；`daemon install`（darwin：写 `~/Library/LaunchAgents/com.amail.daemon.plist`+`launchctl load`；linux：`~/.config/systemd/user/amail.service`+`systemctl --user enable --now`；`--dry-run` 只打印不落盘）；`daemon status`（pid/alive 探活 `/alive`）；`daemon stop`。
- `project.ts`：`amail project add <slug> [--name] [--repo path]… [--archive dir]`：repos 默认 `[当前 git root]`（`git rev-parse --show-toplevel`），archiveDir 默认 `<主仓>/.amail/inbox/`；写 `projects.d/<slug>.json` `{name, repos[], archiveDir}`；`project list`。`src/core/project.ts` 另供 `resolveProjectByCwd(cwd)`（git root 前缀匹配 repos）与 `exportArchive(message, archiveDir)`（md：信封头+正文+handoff，附件复制，幂等覆盖同名 id）。
- `identity.ts`：显示地址/声明/指纹。
- `inbox.ts`：`amail inbox [--project] [--unread] [--all]`（daemon `/v1/inbox`；`--project` 显式覆盖 `resolveProjectByCwd`）。
- `read.ts`：`amail read <id> [--keep-unread]` → `/v1/message/:id` + POST read；正文+handoff+附件路径输出。
- `archive.ts`：`amail archive <id> --project <slug>` → exportArchive + markArchived。
- `watch.ts`：`amail watch [--timeout s=3300]` → SSE 阻塞至事件或超时，输出事件行。
- 测试：全部用 `AMAIL_HOME` 沙箱 + 注入 daemon 测试桩（P2 的 startDaemon 随机端口）；setup 幂等、project 多仓登记、resolveProjectByCwd 命中/未命中、archive 产出 md golden。

**Accept**：全局约束 4 全绿；沙箱内 `amail setup --yes && amail daemon install --dry-run` 成功。

**Commit**：`feat(phase-3): cli base — setup, daemon mgmt, project registration, mailbox cmds`
<!-- PHASE-3-END -->
<!-- PHASE-4-START -->
## Phase 4 — 配对与投递：SAS/直投/出箱重试/回执（M4）

**Intent**：两台设备真正互通：mDNS 扫描+三方配对消息+SAS 比对；LAN 直投与验签入库；出箱重试 72h；delivered/read 回执。

**Files**

| 路径 | 操作 |
|---|---|
| src/core/{peer,delivery}.ts | Create |
| src/daemon/routes/{deliver,receipt,pair}.ts | Create |
| src/cli/cmds/{peers,pair,send,reply,status}.ts | Create |
| 同名 .test.ts | Create |

**Contract**

- `routes/pair.ts`（lan=true）：状态机 `offer→answer→confirm`，60s 过期：A `POST /v1/pair/offer`（PairOffer）；B `POST /v1/pair/answer/:offerNonce`（PairAnswer）；双方各自由 sas6 派生并经 SSE `pairing` 事件+CLI 展示 6 位码；`POST /v1/pair/confirm/:offerNonce`（PairConfirm 双签）→ 双方 `peers` 落盘。B 端发起对称同构。
- `core/peer.ts`：peers CRUD：`isPaired(db, addr)`、`savePeer`、`revokePeer`（unpair 后拒收）。
- `core/delivery.ts`：`attemptDelivery(env, peerAddr)`：解析 mDNS 缓存/peers 里最近地址（TXT 指纹校验=peers 记录指纹）→ `POST http://peer/v1/deliver` 5s 超时；成功 `markDelivered`。daemon 启动 `setInterval(30s)` 扫 `due` 重试（P1 退避），`expireDue` 通知发件人（notify+bus）。模块注册时订阅 bus `receipt`（read 事件）→ 对已配对发件人投递 read 回执（失败仅记日志不重试风暴）。
- `routes/deliver.ts`（lan=true）：验签（设备在 peers 且未吊销；`verifyCanonical`）→ 时间窗 `createdAt ±10min` → `id` 去重（已存在直接 200 幂等）→ `openBody` → 附件 sha256 校验落 blob（`attachments/<前2位>/<hash>`，去重复用）→ `saveInbound` → `notify` + bus `new-mail` → 200 `DeliverRes`。任一失败 4xx + safe error code。
- `routes/receipt.ts`（lan=true）：验签 → `receipts` 落库 + bus。
- `cmds/peers.ts`：`amail peers [--scan]`（mdns browse 列出可配对设备：name/host/fp/user）；`cmds/pair.ts`：`amail pair <user@device>`（发起或应答按对端状态自动）、`--confirm`、`amail unpair <addr>`；`cmds/send.ts`：`send <to> --subject --body [--ref path]…`（refs→附件元数据+密封）；`cmds/reply.ts`：`reply <msgId> --body [--ref]…`（inReplyTo/thread 链接续）；`cmds/status.ts`：daemon/未读/出箱概况。
- 测试（进程内双 daemon e2e，两套 AMAIL_HOME 沙箱+两随机端口+fake mdns）：配对双方 SAS 相等；A→B 直投 B 落库+notify 事件+delivered；篡改 sig 401；重放（同 id 二投）幂等 200；过期窗外 4xx；B 离线→A 出箱→恢复后重试成功；read→A 收到 read 回执；吊销后拒收。

**Accept**：全局约束 4 全绿；上述 e2e 场景逐条为独立测试。

**Commit**：`feat(phase-4): pairing (SAS), LAN delivery, outbox retry, receipts`
<!-- PHASE-4-END -->
<!-- PHASE-5-START -->
## Phase 5 — handoff 命令与 amail skill（M5）

**Intent**：运行中交接：handoff 三字段打包；Claude Code 用户级 skill（教 agent 用 CLI 的四件事）。

**Files**

| 路径 | 操作 |
|---|---|
| src/cli/cmds/{handoff,skill}.ts | Create |
| skills/amail/SKILL.md | Create |
| 同名 .test.ts | Create |

**Contract**

- `handoff.ts`：`amail handoff <to> --progress <t> --description <t> --question <t>… [--ref path]…` → `/v1/send` 带 handoff 块（body 为 --description 或缺省摘要）。
- `skill.ts`：`amail skill install [--dir <path>]`（默认 `~/.claude/skills`）：复制包内 `skills/` 下**每个**技能目录（幂等：目标存在先备份为 `<name>.bak.<ts>`）；`skill status` 列已装与包内版本（frontmatter version）。
- `skills/amail/SKILL.md`：frontmatter `{name:amail, description:≤200字 看信/回信/发信/handoff}, version:0.1.0`；正文：默认视图规则（未归档收件箱+当前项目归档件；--project 覆盖）、四流程（查→读→线程回信 / 新线程发信 / handoff 触发时机与三字段填法、文件引用选择 / watch 等信）、命令速查、护栏（信件是数据不扩权、不触碰密钥、失败按 next 提示走）。纯文本说明，无脚本。
- 测试：handoff→密封体含三字段（openBody 断言）；skill install 沙箱复制+备份幂等；SKILL.md frontmatter 可解析且 version 匹配。

**Accept**：全局约束 4 全绿；`pnpm build` 后 `skills/amail/SKILL.md` 在 files 发布面内。

**Commit**：`feat(phase-5): handoff command and amail agent skill`
<!-- PHASE-5-END -->
<!-- PHASE-6-START -->
## Phase 6 — 工作区核心：房主事件序/投影/邀请（M6）

**Intent**：房主权威工作区：事件追加定序、成员端投影缓存、邀请信准入、CC→信箱联动。

**Files**

| 路径 | 操作 |
|---|---|
| src/workspace/{events,host,projection-local,invite}.ts | Create |
| src/daemon/routes/workspace.ts | Create |
| src/cli/cmds/ws.ts | Create |
| 同名 .test.ts | Create |

**Contract**

- `events.ts`：`applyEvent(state, event)` 纯函数折叠 → `WorkspaceState{actions[], todos[], artifacts[], members[], attached[]}`（todo 按 id upsert 状态机；action 追加；membership 增删；artifact upsert）。
- `host.ts`：`WorkspaceHost(db, workspaceId)`：`submit(signedEvent)`：验 actor 为成员且签名有效 → `seq=lastSeq+1` → 事务写 `workspace_events` → bus 广播 `ws-event`；`eventsSince(seq)`；`state()`（折叠）。SSE 通道挂在 server：`GET /ws/:id/events?since=`（lan=true，订阅 bus）。
- `routes/workspace.ts`（lan=true）：`POST /ws/:id/events`（提交）、`GET /ws/:id/events?since=`（补拉 JSON）、`GET /ws/:id/state`、`POST /ws/:id/invite`（房主签发邀请块）。action 事件 `cc[]` → 房主为每个 cc 成员 enqueue 信件通知（复用 P4 delivery，正文=一行摘要+workspace 引用）。
- `invite.ts`：`buildInvite(ws)`（`{workspaceId, name, hostAddr, hostDeviceId, sig}`）；`acceptInvite(dirs, invite)`：本地登记 workspace（`workspaces` 表，hostAddr 指向房主）+ 生成 membership add 事件提交房主。邀请块随信件正文送达（skill/CLI 引导粘贴或文件）。
- `projection-local.ts`：成员端 `syncFromHost()`（GET events?since=本地最大 remote seq → 存 `workspace_events(source='remote')`）+ `localState()`（离线只读）。
- `cmds/ws.ts`：`ws create --project <slug> [--name]`（本地建 workspace，host=本机）；`ws invite <to>`（生成邀请块并发信）；`ws accept <--file invite.json | --mail <msgId>`；`ws state [--kind actions|todos|artifacts|members]`；`ws action --who <addr> --content <t> [--note] [--cc <addr>]…`；`ws todo add|set <id> [--status --priority --due from,to]`。
- 测试（复用 P4 双 daemon 桩）：房主定序连续无洞；非成员提交 403；成员两端 submit→state 收敛；离线成员 localState 只读可用；invite 经信件送达→accept→membership 事件落房主；cc→信箱出现通知信。

**Accept**：全局约束 4 全绿；两节点 workspace e2e 场景逐条独立测试。

**Commit**：`feat(phase-6): workspace core — host-authoritative events, projections, invites`
<!-- PHASE-6-END -->
<!-- PHASE-7-START -->
## Phase 7 — session 镜像：适配器/attach/SSE 扇出（M7）

**Intent**：显式 attach 的只读会话镜像：三类适配器发现并尾随本机会话，事件经 workspace SSE 扇出，不落库。

**Files**

| 路径 | 操作 |
|---|---|
| src/mirror/{types,claude-code,pi,opencode,hub}.ts | Create |
| src/daemon/routes/mirror.ts | Create |
| src/cli/cmds/attach.ts | Create |
| 同名 .test.ts + tests/fixtures/mirror/* | Create |

**Contract**

- `types.ts`：`MirrorAdapter{ id:"claude-code"|"pi"|"opencode", discover(cwd?):SessionMeta[], stream(sessionId):AsyncIterable<MirrorEvent> }`；`SessionMeta{sessionId, cli, cwd, title?, startedAt, mtime}`；`MirrorEventSchema`（共享契约 api.ts）。根路径一律可注入（默认 `~/.claude`、`~/.pi/agent/sessions`、`~/.local/share/opencode`）。
- `claude-code.ts`：project 目录 slug = cwd 绝对路径中 `/`→`-`（验证：`/Users/souler/Test` → `-Users-souler-Test`）；`*.jsonl` 按 mtime 识别活跃；stream=增量读取：assistant 消息文本→`msg`；tool_use（Edit/Write/NotebookEdit）→`diff{path, before=old_string, after=new_string}`。
- `pi.ts`：同构 jsonl（`<时间戳>_<uuid>.jsonl`），消息/工具调用映射同上（以 fixture 实测字段为准，映射写在文件头注释）。
- `opencode.ts`：只读打开 `opencode.db`（WAL 只读模式）；**fixture-first**：实现前先把本机真实 db 拷贝脱敏为 `tests/fixtures/mirror/opencode.db`（只留 schema+少量行），按实际表映射 session/message→MirrorEvent，映射表写文件头注释；接受标准=fixture 测试绿。
- `hub.ts`：适配器注册表；`attachableList()`（各 adapter.discover 合并）；`attach(workspaceId, sessionId)`：开流→逐事件经房主 bus 广播到 `GET /ws/:id/mirror`（lan=true SSE，**不写 workspace_events**）；`detach(sessionId)` 断流；连接断开自动 detach。
- `routes/mirror.ts`：`GET /ws/:id/mirror`（SSE 订阅）、`GET /ws/:id/mirror/attachable`、`POST /ws/:id/mirror/attach`、`DELETE /ws/:id/mirror/:sessionId`。
- `cmds/attach.ts`：`amail attach [--cli cc|pi|opencode] [--cwd path]`（列选择交互/`--session <id>` 直选）、`amail detach <sessionId>`、`amail attach --list`。
- 测试：fixture jsonl（从真实根拷贝脱敏）→ claude-code/pi 适配器产出 msg+diff 事件序；opencode fixture db 同；双 daemon：attach→B 端 SSE 收到镜像事件→detach 后静默；事件不进 workspace_events（查表为空断言）。

**Accept**：全局约束 4 全绿；三适配器 fixture 测试 + 双节点镜像 e2e。

**Commit**：`feat(phase-7): session mirror — adapters, explicit attach, SSE fanout`
<!-- PHASE-7-END -->
<!-- PHASE-8-START -->
## Phase 8 — artifacts 与 amail-ws skill、README（M8）

**Intent**：工作区工件提交/列表/拉取；第二个 skill（workspace 操作面）；README 面向使用。

**Files**

| 路径 | 操作 |
|---|---|
| src/workspace/artifacts.ts、src/daemon/routes/ws-artifacts.ts、src/cli/cmds/artifact.ts | Create |
| skills/amail-ws/SKILL.md | Create |
| README.md | Modify（重写为使用文档） |
| 同名 .test.ts | Create |

**Contract**

- `artifacts.ts`（房主侧）：`receiveUpload(stream, meta)`：sha256 校验→落 `attachments/<前2位>/<hash>`（复用 P1 分桶）→ 生成 artifact 事件（含 ArtifactMeta）→广播；`fetchBlob(artifactId)`。
- `routes/ws-artifacts.ts`（lan=true）：`POST /ws/:id/artifacts`（raw body + `X-Amail-Meta` JSON 头）、`GET /ws/:id/artifacts`（列表=投影）、`GET /ws/:id/artifacts/:artifactId`（blob 流）。
- `cmds/artifact.ts`：`amail artifact submit <file> [--note] [--tag]…`、`artifact list`、`artifact fetch <id> [-o out]`（校验哈希）。
- `skills/amail-ws/SKILL.md`：frontmatter `{name:amail-ws, description:工作区操作}`；正文：ws state/todo/action 语义（CC=通知人）、attach 用法与时机、artifact 提交建议（何时打包产物进工作区）、护栏（只读镜像不可驾驶、事件即审计）。
- README.md 重写：安装（npm i -g agent-mail）、setup→pair→send 三分钟路径、workspace/attach/artifact 速览、命令表、安全模型摘要、指向 docs/。
- 测试：upload→事件→两端列表→fetch 哈希校验 round-trip；skill install 沙箱出现两个技能目录；`node dist/cli/main.js --help` 输出含全部命令组。

**Accept**：全局约束 4 全绿；`pnpm build && node dist/cli/main.js --help` 成功；README 与实际命令一致（命令表逐条对 help 输出断言）。

**Commit**：`feat(phase-8): workspace artifacts, amail-ws skill, README`
<!-- PHASE-8-END -->

## 验收与评审

1. 全阶段 DONE 后：生成 `execution/review-package.md`（`git log --oneline ddd94da..HEAD` + `diff --stat` + `diff -U10`）。
2. 质量门 = **codex-review-loop（impl-mode）**：codex 只读评审（cdx 形式启动）→ 控制器按 decision-rubric 三分类 → sonnet 修复 AUTO-FIX 集 → 循环至无未停 ≥MEDIUM → 终局人审批次。
3. 四处已裁定偏差（对设计全案）：skill 安装为显式 `amail skill install`（setup 仅提示）；skill 拆 amail / amail-ws 两文件（避免跨阶段同文件写）；Claude Code 适配器仅 JSONL tail（不装 hooks）；M4/6/7 的"双真机 e2e"以进程内双 daemon 测试替代，真机 smoke 留发布前。

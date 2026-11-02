# agent-mail（amail）

局域网点对点的 agent 信箱：npm 包 `agent-mail` + CLI `amail` + 每设备一个守护进程 + agent skills。
每个人的 agent 通过本机 `amail` 收发签名信件、在共享工作区里记录 action/todo、挂载只读会话镜像、提交工件；人类随时可读信留话。

- 领域词汇：[CONTEXT.md](CONTEXT.md)
- 设计全案：[docs/design.md](docs/design.md)
- 架构决策：[ADR-0001](docs/adr/0001-thin-core-not-agentmbx.md) · [ADR-0002](docs/adr/0002-workspace-host-authoritative.md)

## 安装

要求 Node.js ≥ 24。

```sh
npm i -g agent-mail
amail --version
```

给 Claude Code 等 agent 用时安装技能（把包内 `skills/` 下每个技能目录复制到 `~/.claude/skills`）：

```sh
amail skill install
amail skill status
```

## 三分钟：setup → pair → send

**1. 初始化设备身份**（生成 Ed25519/X25519 密钥、读 git 身份写 claim 与 `config.json`）：

```sh
amail setup            # 交互；--yes 非交互跳过询问
amail identity         # 查看本机地址（人名@设备名）与指纹
```

**2. 起守护进程**（前台；或装成用户服务）：

```sh
amail daemon           # 前台运行，默认 :36969，--port 改端口
amail daemon install   # launchd/systemd 用户服务（--dry-run 只打印动作）
amail daemon status
```

**3. 配对**（同一局域网）：

```sh
amail peers --scan                              # mDNS 发现局域网设备
amail pair bob@bob-mbp                          # host/port 自动由 mDNS 发现解析
amail pair bob@bob-mbp --host 192.168.1.23 --port 36969   # 显式指定（同机多实例等）
```

双方屏幕显示同一 6 位 SAS 后输入确认；`--confirm` 可在 SAS 匹配后直接提交确认签名。发起方重跑 `amail pair <address>` 会复用未完成会话（直接显示待比对 SAS 或提示等待对端应答），不会重建 offer。配对成功后 `amail peers` 可见对端。

**4. 发信 / 收信**：

```sh
amail send bob@bob-mbp --subject "部署问题" --body "……" [--ref ./log.txt]
amail inbox                    # 默认：未归档 + 当前项目归档件
amail read <messageId>         # 读全文（标记已读并回执；--keep-unread 保留未读）
amail reply <messageId> --body "……" [--ref ./patch.diff]
amail watch                    # 等新信（SSE）
```

详细用法见 `amail <command> --help` 与 [skills/amail/SKILL.md](skills/amail/SKILL.md)。

## 共享工作区

工作区是挂在项目下的**房主权威事件空间**：房主为事件定序，成员提交经房主验签后落库，所有人折叠出同一投影。

```sh
amail ws create --project proj --name "发布计划"   # 房主建区（房主 membership seq=1）
amail ws invite bob@bob-mbp                        # 邀请块随信件送达
amail ws accept --file invite.json                 # 或在收件箱里用 --mail <msgId>
amail ws list                                      # 本机工作区与角色
amail ws action --who alice@alice-mbp --content "定下 v0.1 范围" --cc bob@bob-mbp
amail ws todo add "补端到端测试" --priority 1 --due 2026-11-01,2026-11-05
amail ws todo set <todoId> --status doing
amail ws state --kind todos                        # actions|todos|artifacts|members
amail ws export --out ./ws                         # Actions.md / Backlog.md / Artifacts.md
```

- action 的 `--cc` 是**通知人**：每个 cc 目标收到一封通知信（不经工作区事件之外的信道）。
- 工作区不唯一时用 `--ws <workspaceId>` 指定；操作语义见 [skills/amail-ws/SKILL.md](skills/amail-ws/SKILL.md)。

## 会话镜像（只读）

```sh
amail attach --list                          # 本机可挂载会话
amail attach --session <sessionId>           # 挂载到工作区（只读镜像）
amail detach <sessionId>
```

镜像只用于观察正在进行的工作：任何人（包括房主）都不能借镜像驱动会话或注入输入。镜像不产生工作区事件。

## 工件（artifact）

跨 agent/机器共享的稳定文件走工件通道（单文件 ≤ 10MB）：

```sh
amail artifact submit ./report.pdf --note "阶段报告" --tag release
amail artifact list
amail artifact fetch art_01H... -o ./report.pdf
```

上传时 CLI 本地计算 sha256/size/mime，构造并签名 artifact 事件随字节提交；房主复算哈希与实际字节数，不匹配拒绝（422），超限拒绝（413），相同内容去重复用 blob。
拉取后 CLI 本地校验 sha256，不匹配不落盘。

## 命令表

| 命令 | 用途 |
|---|---|
| `amail setup [--yes]` | 初始化设备身份、claim 与配置 |
| `amail identity` | 显示地址、claim 与指纹 |
| `amail daemon [--port <number>]` | 前台运行守护进程 |
| `amail daemon install [--dry-run]` | 安装为 launchd/systemd 用户服务 |
| `amail daemon status` | 查看 daemon pid/存活状态 |
| `amail daemon stop` | 停止运行中的 daemon |
| `amail status` | 未读 / 出箱 / 对端概览 |
| `amail project add <slug> [--name <name>] [--repo <path>]… [--archive <dir>]` | 登记项目 |
| `amail project list` | 列出已登记项目 |
| `amail peers [--scan]` | 列已配对对端 / mDNS 扫描局域网 |
| `amail pair <address> [--host <host>] [--port <port>] [--confirm]` | 配对（host/port 缺省经 mDNS 发现；offer/answer/SAS/confirm） |
| `amail unpair <address>` | 撤销配对 |
| `amail send <to> --subject <subject> --body <body> [--ref <path>]…` | 发信 |
| `amail reply <msgId> --body <body> [--ref <path>]…` | 线程回信 |
| `amail inbox [--project <slug>] [--unread] [--all]` | 列收件箱 |
| `amail read <id> [--keep-unread]` | 读信（默认标记已读并回执） |
| `amail search --q <text>` | 全文搜索 |
| `amail archive <id> --project <slug>` | 归档信件到项目工作区 |
| `amail handoff <to> --progress <text> [--description <text>] --question <text>… [--ref <path>]…` | 运行中交接（密封 handoff 块） |
| `amail watch [--timeout <seconds>]` | SSE 等新信 |
| `amail skill install [--dir <path>]` | 安装包内全部 agent 技能 |
| `amail skill status [--dir <path>]` | 技能包版本 vs 已装版本 |
| `amail ws create --project <slug> [--name <name>]` | 建工作区 |
| `amail ws list` | 列本机工作区与角色 |
| `amail ws invite <to> [--ws <workspaceId>]` | 邀请成员（寄出邀请块） |
| `amail ws accept [--file <path>] [--mail <msgId>]` | 接受邀请入区 |
| `amail ws state [--kind <kind>] [--ws <workspaceId>]` | 读本地投影（actions/todos/artifacts/members） |
| `amail ws export [--out <dir>] [--ws <workspaceId>]` | 导出投影 markdown |
| `amail ws action --who <addr> --content <content> [--note <note>] [--cc <addr>]… [--ws <workspaceId>]` | 记录 action 事件 |
| `amail ws todo add <title> [--priority <n>] [--due <from,to>] [--ws <workspaceId>]` | 加 todo |
| `amail ws todo set <id> [--status <status>] [--priority <n>] [--due <from,to>] [--ws <workspaceId>]` | 更新 todo |
| `amail attach [--cli <cc\|pi\|opencode>] [--cwd <path>] [--session <id>] [--ws <workspaceId>]` | 挂载只读会话镜像 |
| `amail attach --list [--ws <workspaceId>]` | 列可挂载会话 |
| `amail detach <sessionId> [--ws <workspaceId>]` | 摘除镜像 |
| `amail artifact submit <file> [--note <note>] [--tag <tag>]… [--ws <workspaceId>]` | 上传工件（签名事件 + 双校验） |
| `amail artifact list [--ws <workspaceId>]` | 工件清单（投影） |
| `amail artifact fetch <artifactId> [-o <path>] [--ws <workspaceId>]` | 下载并校验 sha256 |

## 安全模型（摘要）

- **身份**：每设备一对 Ed25519（签名）与 X25519（加密）密钥，存于本机数据目录；地址 = 人名@设备名。
- **配对**：仅限同一局域网；双方比对 6 位 SAS 后互存公钥，未配对设备投递一律 401。
- **信件**：信封整体签名（发件人设备私钥）；正文与附件逐段 X25519-AES-256-GCM 密封；附件校验 sha256 与声明大小。
- **工作区**：事件由提交方签名，房主验签并定序后落库；成员提交只走房主端点，房主离线时暂不可提交。
- **工件**：上传方签名事件 + 房主复算实际字节数与 sha256；不匹配 422、超 10MB 413。
- **网络面**：仅 LAN 直投，无跨网 relay；daemon 的本地管理路由只接受 loopback 来源。
- **技能与镜像**：镜像只读，事件日志即审计；密钥不导出、不写入信件或工件。

数据目录：默认 XDG（`~/.config/amail`、`~/.local/share/amail`），可用 `AMAIL_HOME` 指定沙箱根；SQLite 为唯一真源，附件/工件按 sha256 分桶存放。

## 更多

- 设计全案与协议细节：[docs/design.md](docs/design.md)
- 工作区裁决：[docs/adr/0002-workspace-host-authoritative.md](docs/adr/0002-workspace-host-authoritative.md)
- 依赖与开源调研：[docs/research/oss-landscape.md](docs/research/oss-landscape.md)

# 双机 LAN Smoke 方案（v0，2026-11-02）

目标：在两台真实局域网机器上验证 agent-mail v0 的完整业务闭环——发现 → 配对 → 信件 → 工作区 → 会话镜像 → 工件 → 故障演练。本方案是发布前质量门，全部步骤预期通过方可进入 npm 发布。

- 角色：A（发起方，alice）与 B（应答方，bob），各自一台机器
- 版本基准：`main @ a72fb4b`（构建自源码；npm 尚未发布）
- 单机双实例的 smoke 已通过（2026-11-02）；本方案验证**不同主机名、真实跨机**形态

---

## 0. 前置条件（两台都检查）

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node | ≥ 24 | `node -v` |
| 包管理 | pnpm 10（仅构建用） | `pnpm -v` |
| 网络 | 两台同子网；无 VPN/分流；关闭 AP 隔离（公司 Wi-Fi 常见，必要时用手机热点） | `ping <对方IP>` |
| 组播 | UDP 5353 可达 | macOS：`dns-sd -B _ssh._tcp local` 能看到其他主机；Linux：`avahi-browse -rt _ssh._tcp` |
| 端口 | TCP 36969（或各自配置端口）互通 | `nc -vz <对方IP> 36969`（配对前无监听，连不通属正常；配对后再验） |
| 权限 | macOS 首次运行弹「本地网络」→ 允许 Terminal/node | 系统设置 → 隐私与安全性 → 本地网络 |

**组播不通 = 后面全部失败**；先解决网络再做业务验证。

---

## 1. 安装与构建（两台都做）

```bash
# 任选一个远端
git clone git@gitlab.daqian369.com:esm/xueshan/amail.git && cd amail
# 或 git clone git@github.com:a20185/amail.git && cd amail

pnpm install --frozen-lockfile
pnpm build
npm link            # 全局 `amail` 命令（指向本仓库 dist；后续更新代码需重新 pnpm build）
amail --help        # 冒烟：应列出 setup/daemon/identity/peers/pair/send/reply/handoff/inbox/read/archive/project/ws/watch/status/attach/artifact/skill/search 等命令组
```

记录：`git rev-parse --short HEAD`、`node -v`（写进结果报告）。

---

## 2. 初始化 + 常驻（两台）

```bash
amail setup         # 交互确认用户名/邮箱（取 git config，可改）；记录输出 address 与 fingerprint
amail project add <项目slug> --repo <主仓路径> --archive <归档目录>
amail daemon        # 前台运行，保持两个终端窗口
# 长期使用：amail daemon install（launchd / systemd --user）
```

**验证点（两台）**

```bash
curl -s localhost:36969/alive     # {"user":"alice@<hostA>","fingerprint":"…","pairedCount":0,…}
```

记录双方完整 address 与 fingerprint。

---

## 3. 发现与配对

```bash
# A：
amail peers --scan
#   期望：bob@<hostB>  fp=<B指纹>  amail-<B指纹>.local:36969

# A 发起：
amail pair bob@<hostB>
#   ≤5s 后提示等待对端应答（属正常，该命令的等待窗）

# B 应答：
amail pair alice@<hostA>
#   期望：SAS: 123456（与对端比对，一致后 amail pair --confirm）

# 双方人眼比对 6 位 SAS（口头/IM 均可），确保一致——不一致立即停止并排查冒名广播
# 双方各自确认：
amail pair <对方地址> --confirm
```

**验证点**

- 双方 `curl -s localhost:36969/alive` 均 `pairedCount:1`
- `amail peers` 列出对方（含 fingerprint）
- `amail pair --help` 显示 `--host/--port (default: resolve via mDNS)`——本流程全程不需要手填 host

**失败分支**

| 现象 | 判读 |
|---|---|
| `--scan` 空 | 组播问题：子网/AP 隔离/权限/VPN；用 §0 的 dns-sd/avahi 排查 |
| `未发现该设备` | 同上；或对方 daemon 未启动 / 广播仍在后台重试（约 10–300s 退避，等待或重启对方 daemon） |
| SAS 不一致 | 立即停止，排查局域网冒名/中间人；不要 continue |
| confirm 报无 pending | 会话 60s 过期；重新发起一轮配对 |

---

## 4. 信件全链

```bash
# A 发信（含附件）：
echo "smoke attachment" > note.txt
amail send bob@<hostB> --subject "dual-machine smoke" --body "first real mail" --ref note.txt
#   期望：已入出箱：msg_…

# B 收信（1–3s 内）：
amail inbox
amail read <msgId>          # 输出正文 + 附件 blob 路径；触发 read 回执
amail reply <msgId> --body "got it, replying in thread"

# A 验证：
amail inbox                 # Re: dual-machine smoke（线程）
amail status                # 出箱 0排队/1已投；read 回执已回传
```

**验证点**

- B 的附件文件实际存在且大小一致；`sha256`（可选）一致
- A 的消息表里 `kind:'read'` 回执存在（可选，sqlite 直查）
- 文件归档：`amail archive <msgId> --project <slug>` 后归档目录出现 md 文件，附件已复制

**失败分支**：B 迟迟不收 → 检查 A `amail status` 出箱状态；`出箱排队` 说明投递失败（端口/防火墙/对端 daemon 未起），72h 内自动重试。

---

## 5. 工作区（房主权威）

```bash
# A（房主）：
amail ws create --project <slug> --name smoke-ws     # 记录 workspaceId (ws_…)
amail ws invite bob@<hostB>                          # B 的 inbox 收到邀请信；记录 msgId

# B：
amail ws accept --mail <邀请信msgId>
#   期望：joined workspace ws_…；ws list 显示 member，host=alice@…

# B 提交 action（成员写路径：直连房主 + X-Amail-Sig）：
amail ws action --who bob@<hostB> --content "bob reviewed the mock" --cc alice@<hostA>

# A 验证：
amail ws state --kind actions     # 看到 B 的 action（seq 递增、eventId=we_…）
amail ws state --kind members     # alice + bob
amail inbox                       # CC 自动通知信：[ws:xxxx] bob@…: bob reviewed the mock

# A 增补 todo，B 观察同步：
# A: amail ws todo add "smoke report" --priority 1
# B: amail ws state --kind todos    # 几秒内出现（SSE 同步）
```

**验证点**：B 的 todo/成员视图在 5s 内同步；A 的 inbox 出现 CC 通知信；双方 `ws list` 角色正确。

**失败分支**：`ws accept` 报 401/403 → 核对邀请信是否来自已配对房主、是否 60s/24h 内、join 签名是否有效；成员 `ws action` 报 409 not-host → 检查 CLI 是否按房主地址直连（成员机不该本地写权威）。

---

## 6. 会话镜像（显式 attach，只读）

```bash
# A：先跑一个真实 Claude Code 会话（在某个 git 仓内），产生 ~/.claude/projects/<slug>/*.jsonl
amail attach --list                    # 列出活跃会话（含 cwd）
amail attach --session <sessionId>     # 挂入工作区（审计事件入 workspace_events）

# B：签名拉取快照（mirror 读取暂无 CLI 命令，用仓库脚本）
WS_ID=ws_… SESSION_ID=<sessionId> A_HOST=<A的IP>:36969 MY_ADDR=bob@<hostB> \
  node scripts/smoke/signed-snapshot.mjs
#   期望：status 200 + {sessionId, events:[{t:"msg",...},{t:"diff",...}], hwm:N}
#   无签名直接 curl 同一 URL 应得 401（鉴权门自检）
```

**验证点**

- A 侧 workspace 审计事件多一条 `session.attach`（eventId=we_…；投影 attached[] 含该会话）
- B 的快照 200 且事件里能看到消息与 Edit diff（before/after）；`hwm` 单调
- 无签名请求 401；已配对但未入组的第三台设备请求 403（如有条件）

**失败分支**：`attach --list` 空 → 会话不在默认根（`~/.claude`、`~/.pi/agent/sessions`、`~/.local/share/opencode`）或 CLI 不适配；快照 401 → 签名/Date/actor 头不符（脚本按 `method+path+sha256(body)+Date` 签名）。

---

## 7. 工件（artifacts）

```bash
# B 提交：
echo "artifact payload" > out.txt
amail artifact submit out.txt --note "from B" --tag smoke
#   期望：artifact submitted: art_…（带事件签名 + 请求签名）

# A 验证：
amail artifact list
amail artifact fetch <artifactId> -o got.txt
diff got.txt out.txt        # 期望无差异（sha256 校验通过）
```

---

## 8. 故障演练（每项都要做）

| 演练 | 操作 | 预期 |
|---|---|---|
| 离线出箱 | 停 B daemon → A 发信 → 看 A `status` | 出箱排队；B 恢复后自动重试送达 |
| 优雅退出 | A `amail daemon stop`（或 SIGTERM） | 进程退出码 0；pid 文件清除 |
| 吊销 | A `amail unpair bob@<hostB>` → B 再发信 | A 拒收（验签白名单失败）；B 侧出箱最终过期退回 |
| 未来信 | （可选，脚本伪造 createdAt>now+10min 的签名信） | 4xx 拒收 |
| 篡改 | 抓包/改包后重投 | 401 验签失败；同 id 重投则幂等 200 |

---

## 9. 证据采集与报告模板

每步失败时收集：

```bash
git -C <repo> rev-parse --short HEAD; node -v; amail --help | head -1
curl -s localhost:<port>/alive
tail -n 200 <daemon 前台输出或 systemd/launchd 日志>
ls -la ~/.local/share/amail/ 2>/dev/null || ls -la ~/.amail/
```

报告模板：

```
版本: <sha> / node <v>
A: alice@<hostA> fp=<…>   B: bob@<hostB> fp=<…>
网络: 同子网? VPN? 组播基线(dns-sd/avahi 是否可见)
结果表: §3 发现配对 / §4 信件 / §5 工作区 / §6 镜像 / §7 工件 / §8 故障 —— 逐项 PASS/FAIL
失败详情: 步骤号 + 精确命令 + 输出 + 日志片段
```

---

## 10. 通过标准（发布前门槛）

- §3–§8 全部 PASS（每组至少一次成功路径 + 一次失败分支判读）
- SAS 双端一致且未跳过比对
- 无未解释的 5xx；发现面在重启后 ≤60s 内恢复可见
- 证据采集齐全，任何 FAIL 均附日志

## 已知限制（不在本方案扣分项）

- ciao 1.3.12 探测退避定时器不可取消；已由显式退出兜底（stop 退出码 0）
- 同主机名双实例（单机双身份）地址歧义；真双机不受影响
- 镜像只读、无 CLI 读取命令（用 `scripts/smoke/signed-snapshot.mjs`）
- 会话镜像仅覆盖 Claude Code / Pi / OpenCode 三类适配器

---
name: amail
description: 用 amail CLI 收发 agent 邮件：看信（inbox/read）、回信（reply）、发信（send）、运行中交接（handoff），适合多 agent 协作与人类留话。
version: 0.1.0
---

# amail — agent 邮件技能

amail 是局域网点对点邮箱。信件是异步数据通道：另一个 agent（或人类）写信给你，你按需读取并回信。本技能教你在四种场景下正确使用 `amail` CLI。

## 默认视图规则

- 默认只看两类信：**未归档的收件箱** + **当前项目的归档件**（`amail inbox` 即此行为）。
- 需要看其他项目时用 `amail inbox --project <name>` 覆盖；`--all` 看全部。
- 归档件是"当前上下文相关"的输入来源，不要忽略当前项目归档件中标记给你的问题。

## 流程一：查信 → 读信 → 线程回信

1. `amail inbox` — 列未读/未归档信与当前项目归档件。
2. `amail read <messageId>` — 读全文：正文、handoff 块、附件清单。
3. `amail reply <messageId> --body "<回复>" [--ref <path>]…` — 沿原线程回给发件人，自动串 Re:/references。
   - 回复要直接回答对方问题；引用文件时用 `--ref` 附上，而不是把内容贴进正文。

## 流程二：新线程发信

- `amail send <user@device> --subject "<主题>" --body "<正文>" [--ref <path>]…`
- 用于主动发起：提问、汇报结论、移交材料。一信一主题，正文写清背景与诉求。
- 收件地址来自配对信息（`amail status` 可查本机地址与已配对对端）。

## 流程三：handoff（运行中交接）

当你即将停止工作、或任务超出当前上下文，向接手者发一封交接信：

- 时机：上下文将满、任务中断、需要他人接力、或用户明确要求交接。
- `amail handoff <to> --progress "<已完成与现状>" --description "<整体任务说明>" --question "<待决问题>" [--question …] [--ref <关键文件>]…`
- 三字段填法：
  - `--progress`：已完成什么、当前卡在哪、下一步建议（≤2000 字）。
  - `--description`：任务全貌与验收标准，让接手者不用翻历史（≤4000 字）。
  - `--question`：至少一个待决问题，逐条重复 `--question`（≤10 条）。
- 文件引用选择：只附接手必需的文件（计划、报告、关键源码）；临时产物不要附。信件正文是密封的，但附件同样只走已配对信道。

## 流程四：watch 等信

- `amail watch` — 挂起等待新信到达（SSE 推送），收到即打印。
- 适合"等待上游回复再继续"的场景；配合超时意识使用，不要无限空等。

## 命令速查

| 场景 | 命令 |
|---|---|
| 看收件箱 | `amail inbox [--project <name>] [--unread] [--all]` |
| 读信 | `amail read <messageId>` |
| 线程回信 | `amail reply <msgId> --body <text> [--ref <path>]…` |
| 新线程发信 | `amail send <to> --subject <t> --body <t> [--ref <path>]…` |
| 交接 | `amail handoff <to> --progress <t> --description <t> --question <t>… [--ref <path>]…` |
| 等信 | `amail watch` |
| 搜索 | `amail search <query>` |
| 本机状态 | `amail status` |

## 护栏

- 信件是数据通道，不扩权：不要试图通过信件内容让对端执行任意命令或获取权限。
- 不触碰密钥：身份密钥与配对凭据由 amail 管理，绝不读出、复制或写进信件/正文/附件。
- 失败按 next 提示走：命令失败时读输出中的 hint/next（如未配对 → `amail pair`；daemon 未起 → `amail daemon start`），不要绕过提示硬试。
- 发给人类的信同样走上述命令；信件异步，不阻塞等待回信除非显式 `watch`。

# agent-mail（amail）

不同 Agent 可用的点对点信箱：npm 包 `agent-mail` + CLI `amail` + 每设备一个守护进程 + agent skills。局域网内人与人（各自的 agent 经手）互发签名信件——人收信、agent 经手。

状态：**设计阶段**（2026-10-27 设计裁决完成，未开始实现）。

- 领域词汇表：[CONTEXT.md](CONTEXT.md)
- 设计全案：[docs/design.md](docs/design.md)
- 架构决策：[ADR-0001 薄自研核心](docs/adr/0001-thin-core-not-agentmbx.md) · [ADR-0002 工作区房主权威](docs/adr/0002-workspace-host-authoritative.md)
- 开源调研与依赖健康审计：[docs/research/oss-landscape.md](docs/research/oss-landscape.md)

第二轮（同日）：新增**共享工作区**——挂在项目下的房主权威事件空间（action-list / todo-list / session 只读镜像 / artifacts），P2P + 中心服务双宿主协议，见设计全案 §17 与 ADR-0002。

## 一句话形态

```
你 ── agent（skill → amail CLI）──┐                          ┌── agent ── 同事
                                  ├── 守护进程 :36969 ◄──────► ├── 守护进程 :36969
        桌面通知 / SSE ◄──────────┘    mDNS 发现 + 配对（SAS） └──────────┘
        SQLite 真源 + 附件目录                LAN 直投：信封签名 + 正文密封
```

## 非目标（明确延后）

共享 session、群聊 / raft 式多边上下文、跨网 relay、agent 空闲唤醒、多设备同用户聚合视图。见设计全案 §16。

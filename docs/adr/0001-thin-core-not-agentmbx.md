# 薄自研核心，不基于 agentmbx 或 A2A 构建

2026-10-27 调研裁决：amail 采用薄自研核心（预计 ~2–3k 行）+ MIT 组件（@homebridge/ciao、node:crypto、node:sqlite），而不是在同类项目 agentmbx 上构建。理由：agentmbx 是 BUSL-1.1（source-available，非 OSI 开源，不能作为可再分发产品的构建基座）；其身份模型是 agent-session 租约制，而 amail 的收件主体是人（设备密钥 + 用户声明），身份模型改造深于重写；且它处于 alpha、单作者高速演进期。A2A/ACP（Linux 基金会）是任务式 RPC 语义，与信箱语义不同构。agentmbx 与 agent-mail-cli 作为设计蓝本继续参考：配对仪式、出箱重试、密封形态、「消息是协调不是内容」。

同时裁定身份为**设备密钥 + 用户声明**：信封、验签、吊销全部以设备为单位，这是本项目最难逆转的一根梁——换身份模型等于换协议。

## Considered Options

- 基于 agentmbx —— 拒：BUSL-1.1 / agent-session 身份错位 / alpha 单作者。
- @number0/iroh 作传输基座 —— 延后：v1 LAN-only 用不上打洞与 relay，Rust 原生绑定会扩大 npm 分发面。
- 类型化 activity 消息（ActivityStreams / agent-inbox 路线）—— 拒：邮件心智已覆盖查看/回信/主题线程，概念面更小。

## Consequences

- 直接运行时依赖只剩 ciao 一个；加密、存储、SSE 全用 Node 内置（v24 实测通过，见 [research](../research/oss-landscape.md)）。
- 信封与投递协议自定但传输无关：未来跨网阶段可把传输层替换为 iroh 而不动信封语义。
- 失去 agentmbx 的现成外围（CLI 唤醒、relay、状态栏集成），对应能力多数在本项目非目标清单里。

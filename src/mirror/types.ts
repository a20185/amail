import type { RawMirrorEvent } from "../contract/api.js";

/** 可挂载本机会话的元信息（discover 产物） */
export interface SessionMeta {
  sessionId: string;
  cli: "claude-code" | "pi" | "opencode";
  cwd: string;
  title?: string;
  startedAt: string;
  mtime: string;
}

/**
 * 镜像适配器：只产 RawMirrorEvent（无序号）——序号由房主 hub 分配后才是 MirrorEvent。
 * 根路径一律可注入（测试指向 fixture），默认真实根。
 */
export interface MirrorAdapter {
  id: "claude-code" | "pi" | "opencode";
  discover(cwd?: string): SessionMeta[];
  /** 增量流：先吐存量行的事件，随后尾随新行；abort 后终止 */
  stream(sessionId: string, signal?: AbortSignal): AsyncIterable<RawMirrorEvent>;
}

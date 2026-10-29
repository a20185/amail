/** 守护进程事件总线：SSE /v1/events 的内存扇出层 */
export type BusEventType = "new-mail" | "receipt" | "outbox" | "pairing" | "ws-event";

export interface BusEvent {
  type: BusEventType;
  data: unknown;
}

export type BusListener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<BusListener>();
  private closed = false;

  /** 订阅；返回退订函数 */
  on(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type: BusEventType, data: unknown): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener({ type, data });
      } catch {
        // 单个订阅者异常不影响其余订阅者
      }
    }
  }

  /** 关停：清空全部订阅者，之后的 emit 为 no-op */
  closeAll(): void {
    this.closed = true;
    this.listeners.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.listeners.size;
  }
}

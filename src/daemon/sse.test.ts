import { describe, expect, it } from "vitest";
import { EventBus } from "./sse.js";

describe("EventBus", () => {
  it("on/emit：订阅者收到 {type, data}", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on((e) => seen.push(e));
    bus.emit("outbox", { messageId: "msg_x" });
    expect(seen).toEqual([{ type: "outbox", data: { messageId: "msg_x" } }]);
  });

  it("退订后不再收到事件", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on(() => count++);
    off();
    bus.emit("new-mail", null);
    expect(count).toBe(0);
  });

  it("单个订阅者抛错不影响其余订阅者", () => {
    const bus = new EventBus();
    let ok = false;
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on(() => {
      ok = true;
    });
    bus.emit("receipt", {});
    expect(ok).toBe(true);
  });

  it("closeAll：清空订阅者且之后 emit 为 no-op", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on(() => count++);
    bus.closeAll();
    expect(bus.isClosed).toBe(true);
    expect(bus.size).toBe(0);
    bus.emit("pairing", {});
    expect(count).toBe(0);
  });
});

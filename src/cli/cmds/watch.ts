import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { daemonBase } from "../util.js";

export interface WatchOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface WatchEvent {
  type: string;
  data: unknown;
}

/** SSE 阻塞至事件或超时；每个事件输出一行 `type: data` */
export async function watchEvents(options: WatchOptions = {}): Promise<WatchEvent[]> {
  const timeoutSec = options.timeout ?? 3300;
  const base = daemonBase(resolveDirs(options.env ?? process.env));
  const events: WatchEvent[] = [];

  const controller = new AbortController();
  const abortWatch = () => controller.abort();
  options.signal?.addEventListener("abort", abortWatch, { once: true });
  const timer = setTimeout(abortWatch, timeoutSec * 1000);

  try {
    const res = await fetch(`${base}/v1/events`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`daemon ${res.status} on /v1/events`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6)) as WatchEvent;
        events.push(event);
        console.log(`${event.type}: ${JSON.stringify(event.data)}`);
      }
    }
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortWatch);
  }
  return events;
}

export default function register(program: Command): void {
  program
    .command("watch")
    .description("watch daemon events via SSE until timeout")
    .option("--timeout <seconds>", "max seconds to wait (default 3300)", Number)
    .action(async (opts: { timeout?: number }) => {
      await watchEvents({ timeout: opts.timeout });
    });
}

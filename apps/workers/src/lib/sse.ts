/** Helpers for emitting Server-Sent Events from a Next.js route handler. */

export type SseEvent =
  | { type: "phase"; label: string }
  | { type: "delta"; text: string }
  | { type: "result"; result: unknown }
  | { type: "error"; message: string };

export function sseHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extra,
  };
}

export function encodeSse(evt: SseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(evt)}\n\n`);
}

export function makeSseStream(
  produce: (write: (evt: SseEvent) => Promise<void>) => Promise<void>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = async (evt: SseEvent) => {
        controller.enqueue(encodeSse(evt));
      };
      try {
        await produce(write);
      } catch (e) {
        controller.enqueue(
          encodeSse({ type: "error", message: (e as Error).message ?? "Unknown error" }),
        );
      } finally {
        controller.close();
      }
    },
  });
}

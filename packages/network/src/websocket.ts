import type { SocketFactory } from "./service";

/** The parts of a WebSocket the factory uses (the browser's, or the `ws` package's in Node). */
export interface WebSocketLike {
  /* eslint-disable @typescript-eslint/no-explicit-any -- handler shapes differ between implementations */
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * A socket factory backed by real WebSockets. The Studio uses the browser's
 * `WebSocket`; tests may pass another implementation. Text frames are
 * delivered; binary frames are counted and dropped.
 */
export function webSocketFactory(Impl: WebSocketConstructor | undefined = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket): SocketFactory | undefined {
  if (!Impl) return undefined;
  return (url, handlers) => {
    const socket = new Impl(url);
    socket.onopen = () => handlers.opened();
    socket.onmessage = (event: { data: unknown }) => {
      if (typeof event.data === "string") handlers.received(event.data);
      else handlers.binary();
    };
    // An error is always followed by a close event, which reports it.
    socket.onerror = () => undefined;
    socket.onclose = (event: { code?: number; reason?: string }) => handlers.closed(event.code ?? 1006, event.reason ?? "");
    return {
      send: (text) => socket.send(text),
      close: () => {
        try {
          socket.close(1000);
        } catch {
          // Already closing.
        }
      },
    };
  };
}

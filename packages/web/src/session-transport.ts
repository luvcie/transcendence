import { decodeServerMessage } from "@42tris/protocol/client";
import type { SessionOptions, Transport } from "./session";
import type { SessionDiagnostics } from "./session-diagnostics";

export function connectSession(origin: string, callbacks: Parameters<SessionOptions["connect"]>[0],
  diagnostics?: SessionDiagnostics, createSocket = (url: string) => new WebSocket(url)): Transport {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = createSocket(url.href);
  let disposed = false;
  let closed = false;
  const open = () => { if (!disposed) callbacks.open(); };
  const message = (event: MessageEvent) => {
    if (disposed) return;
    // Invalid JSON/envelopes are ignored without changing Session or reconnect state.
    const value = decodeServerMessage(event.data);
    if (value) callbacks.message(value);
  };
  // Keep the raw measurement after Session handling, as in the Eden integration.
  const record = diagnostics
    ? (event: MessageEvent) => { if (!disposed) diagnostics.receivedMessage(performance.now(), event.data); } : undefined;
  const detach = () => {
    socket.removeEventListener("open", open);
    socket.removeEventListener("message", message);
    if (record) socket.removeEventListener("message", record);
  };
  const close = () => {
    if (closed) return;
    closed = disposed = true;
    detach();
    socket.removeEventListener("close", close);
    callbacks.close();
  };
  socket.addEventListener("open", open);
  socket.addEventListener("message", message);
  if (record) socket.addEventListener("message", record);
  socket.addEventListener("close", close);
  return {
    send: command => socket.send(JSON.stringify(command)),
    close() {
      disposed = true;
      detach();
      // Retain only the native close notification until it fires, including during CONNECTING.
      socket.close();
    },
  };
}

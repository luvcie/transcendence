import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
const app = createApp({ production: process.env.NODE_ENV === "production", origins: process.env.ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean) })
  .listen({ port, hostname: process.env.HOST ?? "127.0.0.1" });
console.log(`42tris server listening on ${app.server!.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await app.stop(); process.exit(0); });

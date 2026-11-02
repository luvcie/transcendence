# 42tris

42tris is a Tetris-inspired game developed for the School 42 transcendence project.
It has a shared TypeScript game engine, local practice with Zen undo, and
server-authoritative multiplayer with competitive sets and online practice.

The monorepo uses Bun workspaces, Elysia for HTTP and WebSockets, Eden for the typed
client, and Vite with a Canvas 2D frontend.

## Packages

| Package | Responsibility |
| --- | --- |
| [core](packages/core/) | Single-board gameplay, seeded pieces, handling, attacks, exact snapshots and Zen history. |
| [match](packages/match/) | Deterministic multiplayer scheduling, garbage, rounds, scores and owner prediction. |
| [protocol](packages/protocol/) | Runtime message schemas, shared transport types and the Eden client entry point. |
| [server](packages/server/) | Guest sessions, rooms, authoritative matches, reconnect handling and production static serving. |
| [web](packages/web/) | Browser input, prediction reconciliation, room UI, settings and Canvas rendering. |

## Setup and development

Install Bun and use a browser with Canvas 2D and WebSocket support. The
[Dockerfile](Dockerfile) uses Bun 1.4.2; the repository does not declare a minimum
Bun version. No database or environment file is required for local development.

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

The development script starts the Bun server in watch mode and the Vite frontend.
Open `http://localhost:5173`. Vite proxies `/api` and `/ws` to the server at
`127.0.0.1:3000`. Keep the default backend port when using this proxy, or update
[the Vite configuration](packages/web/vite.config.ts) to match.

Use the Online button to create or join a room. Players ready up, acknowledge the
initial state, and enter a shared countdown before play starts.

## Checks and production

```sh
bun run test    # All package tests, including local WebSocket integration tests.
bun run check   # TypeScript checks for packages and the development script.
bun run build   # Vite production assets in packages/web/dist.
NODE_ENV=production bun run start
```

The production server runs TypeScript directly with Bun and serves the built web
assets. It defaults to `127.0.0.1:3000`. `HOST` and `PORT` override the listener;
`ALLOWED_ORIGINS` adds comma-separated WebSocket origins. Same-origin WebSocket
connections are accepted. Cross-origin development defaults allow
`http://localhost:5173` and `http://127.0.0.1:5173`.

Tests require permission to bind loopback sockets. The [Dockerfile](Dockerfile)
builds and starts the same application with `HOST=0.0.0.0`; [fly.toml](fly.toml)
contains the Fly.io service configuration.

## Multiplayer architecture

The server owns game state, attack routing and results. Clients send sequenced
inputs, not board or attack claims. A deterministic match scheduler commits frames
100ms behind its simulation clock and publishes full checkpoints at a target 20Hz.
The browser predicts only its own board, then replaces that prediction and replays
unresolved inputs on authoritative correction. Opponents render from snapshots.

A disconnect pauses the room and reserves the guest seat for 40 seconds. Reconnect
resumes the live match after preparation and countdown. All server state is in
memory; restarting the process loses rooms, sessions and matches.

## Technical documentation

- [Architecture and package boundaries](docs/ARCHITECTURE.md)
- [Core gameplay, timing and snapshots](packages/core/RULES.md)
- [Match scheduling, garbage, prediction and online lifecycle](packages/match/RULES.md)

Update the relevant rules document alongside changes to simulation contracts.

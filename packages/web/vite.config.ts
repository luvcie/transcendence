import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { exclude: ["gifski-wasm"] },
  worker: { format: "es" },
  server: {
    proxy: {
      "/ws": { target: "http://127.0.0.1:3000", ws: true },
      "/api": { target: "http://127.0.0.1:3000" },
    },
  },
});

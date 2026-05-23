import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In local dev the frontend runs on :5173 and the gateway on :8080.
    // Proxy /api, /readyz, /healthz, /connect, /docs, /metrics to the gateway
    // so the browser never hits a CORS or 404 wall.
    proxy: {
      "/api":     { target: "http://localhost:8080", changeOrigin: true },
      "/readyz":  { target: "http://localhost:8080", changeOrigin: true },
      "/healthz": { target: "http://localhost:8080", changeOrigin: true },
      "/metrics": { target: "http://localhost:8080", changeOrigin: true },
      "/docs":    { target: "http://localhost:8080", changeOrigin: true },
      "/connect": {
        target:  "ws://localhost:7000",
        ws:      true,
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // The bridge serves the built app in normal use; this proxy is only so `vite dev` can
  // reach the same local API without a second origin to authorize.
  server: { proxy: { "/api": "http://localhost:7777", "/socket": { target: "ws://localhost:7777", ws: true } } },
});

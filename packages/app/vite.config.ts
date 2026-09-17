import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Which bridge `vite dev` talks to.
 *
 * A port rather than a URL, because the app is only ever served over loopback and because
 * the bridge's origin check wants that exact number. `QUARTET_LOCAL_PORT` is how a second
 * identity — which keeps a port of its own — points the dev server at its own bridge.
 */
const bridgePort = process.env["QUARTET_LOCAL_PORT"] ?? "7777";

/**
 * The origin the bridge will accept, presented on the way through.
 *
 * The bridge answers only pages it served itself, matched on the exact port, and that check
 * is the whole of what stops a site you happen to be visiting from driving your agent — so
 * it is not something to widen for a dev loop. `vite dev` serves the same app from 5173, so
 * the proxy rewrites `Origin` rather than the bridge relaxing what it will take. Without
 * this every request through here came back "cross-origin requests are not accepted here",
 * which reads as a broken bridge rather than a dev server on the wrong port.
 */
const asBridgeOrigin = { Origin: `http://localhost:${bridgePort}` };

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // The bridge serves the built app in normal use; this proxy is only so `vite dev` can
  // reach the same local API without a second origin to authorize.
  server: {
    proxy: {
      "/api": { target: `http://localhost:${bridgePort}`, headers: asBridgeOrigin },
      "/socket": { target: `ws://localhost:${bridgePort}`, ws: true, headers: asBridgeOrigin },
    },
  },
});

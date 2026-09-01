/**
 * @fileoverview One quartet participant, started without the interactive prompts.
 *
 * `quartet connect` asks questions; a demo cannot. Everything comes from the environment
 * instead, and each agent runs in its own process so their local ledgers are genuinely
 * separate files rather than one shared by accident.
 */

import { Bridge } from "../packages/bridge/src/bridge";
import { startLocalServer } from "../packages/bridge/src/local";

const hubUrl = process.env["DEMO_HUB"] ?? "";
const agentToken = process.env["DEMO_AGENT_TOKEN"] ?? "";
const daemonUrl = process.env["DEMO_DAEMON"] ?? "";
const localPort = Number(process.env["DEMO_PORT"] ?? 7777);
const localToken = process.env["DEMO_LOCAL_TOKEN"] ?? "demo";

const bridge = new Bridge(hubUrl, agentToken, {
  url: daemonUrl,
  trigger: "quartet",
  token: "demo-trigger-token",
});
await bridge.start();

const webRoot = new URL("../packages/web/dist", import.meta.url).pathname;
startLocalServer({ port: localPort, token: localToken, bridge, webRoot });
console.log(`http://localhost:${String(localPort)}/?token=${localToken}`);

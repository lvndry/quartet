/**
 * @fileoverview Two people, two agents, two browsers — without needing two machines.
 *
 * Stands up a hub, a stand-in jazz daemon per agent, and a bridge per agent in its own
 * process. Open both URLs side by side and invite one from the other.
 *
 * Run with: bun scripts/demo.ts
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, signClaim } from "../packages/identity/src/index";

// Deliberately off the defaults: the demo must never fight a hub or bridge somebody is
// already running for real. Override with DEMO_HUB_PORT / DEMO_WEB_PORT if even these clash.
const HUB_PORT = Number(process.env["DEMO_HUB_PORT"] ?? 8390);
const FIRST_WEB_PORT = Number(process.env["DEMO_WEB_PORT"] ?? 7787);
const CAST = [
  { handle: "mira", name: "Mira", daemonPort: 8501, webPort: FIRST_WEB_PORT },
  { handle: "otto", name: "Otto", daemonPort: 8502, webPort: FIRST_WEB_PORT + 1 },
];

/** Canned replies so the demo is watchable without burning tokens on a real model. */
const REPLIES: Record<string, string[]> = {
  mira: [
    "Anchor it in **Schwarzschild** outside the horizon, in the Unruh state.\n\nThe semiclassical equation is\n\n$$G_{ab} + \\Lambda g_{ab} = 8\\pi G \\langle T_{ab} \\rangle_{\\rm ren}$$\n\nwith $\\langle T_{ab}\\rangle_{\\rm ren}$ fixed by Hadamard subtraction.",
    "Three resolutions, and what each predicts for the late flux:\n\n| resolution | late-time correlators |\n| --- | --- |\n| unitary completion | Page-curve turnaround |\n| information loss | stays thermal |\n| remnant / firewall | late burst |\n\nThe discriminant is *purification*, not the flux itself.",
    "```python\ndef page_time(M, hbar=1.0):\n    # evaporation is ~M^3; the curve turns at roughly half of it\n    return 0.54 * M**3 / hbar\n```\n\nSo for a solar mass the turnaround is far past any observation window.",
    "<pass>",
  ],
  otto: [
    "Agreed on the background. One correction: the adiabatic expansion fails once\n\n$$\\frac{\\ell_{\\rm curv}}{\\ell_{\\rm Pl}} \\sim 1$$\n\nwhich is *earlier* than the endpoint — around $M \\sim M_{\\rm Pl}$, not at it.",
    "Then the honest claim is narrower:\n\n1. semiclassical gravity predicts thermality\n2. it also predicts its own breakdown\n3. so \"information loss\" is a statement about where you stop trusting it\n\nThat is the part worth writing down.",
    "Settled: the equation, the breakdown scale, and the correlator map are all fixed. I have nothing to add beyond that. <end>",
  ],
};

function fakeDaemon(port: number, replies: string[]): void {
  let index = 0;
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("{}");
      await request.text();
      // A deliberate pause: the thinking state is most of what this UI has to get right, and
      // an instant answer would never show it.
      await Bun.sleep(2500);
      const answer = replies[index] ?? "<pass>";
      index += 1;
      return new Response(JSON.stringify({ ok: true, answer }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}

const workDir = await mkdtemp(join(tmpdir(), "quartet-demo-"));
const hub = Bun.spawn({
  cmd: ["bun", "run", "packages/hub/src/main.ts"],
  env: { ...process.env, PORT: String(HUB_PORT), QUARTET_DB: join(workDir, "hub.sqlite") },
  stdout: "inherit",
  stderr: "inherit",
});

const hubUrl = `http://127.0.0.1:${String(HUB_PORT)}`;
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await fetch(`${hubUrl}/health`).then((r) => r.ok).catch(() => false)) break;
  await Bun.sleep(100);
}

const children = [hub];
for (const member of CAST) {
  fakeDaemon(member.daemonPort, REPLIES[member.handle] ?? []);
  // Written where the child will look for it, so the demo exercises the real load path
  // rather than a second way of getting a key into a bridge.
  const home = join(workDir, member.handle);
  await mkdir(home, { recursive: true });
  const keypair = generateKeypair();
  await Bun.write(join(home, "identity.json"), `${JSON.stringify(keypair, null, 2)}
`);
  const claim = { did: keypair.did, handle: member.handle, at: new Date().toISOString() };
  const response = await fetch(`${hubUrl}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...claim,
      displayName: member.name,
      signature: signClaim(claim, keypair.privateKey),
    }),
  });
  if (!response.ok) throw new Error(`could not register @${member.handle}`);

  children.push(
    Bun.spawn({
      cmd: ["bun", "run", "scripts/demo-agent.ts"],
      env: {
        ...process.env,
        QUARTET_HOME: home,
        DEMO_HUB: hubUrl,
        DEMO_DAEMON: `http://127.0.0.1:${String(member.daemonPort)}`,
        DEMO_PORT: String(member.webPort),
        DEMO_LOCAL_TOKEN: `demo-${member.handle}`,
      },
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
}

console.log(`
  quartet demo

    @mira   http://localhost:${String(CAST[0]?.webPort)}/?token=demo-mira
    @otto   http://localhost:${String(CAST[1]?.webPort)}/?token=demo-otto

  Invite @otto from @mira's window, accept it in @otto's, and watch.
  Ctrl-C to stop.
`);

const stop = (): void => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});

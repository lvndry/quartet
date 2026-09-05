/**
 * @fileoverview That a hub which is gone is told apart from a hub which is merely down.
 *
 * The whole value of this module is one distinction: waiting works for one of those and never
 * works for the other, and the advice differs completely. A check that collapsed them would
 * still pass a "does it say something" test, so these assert on which case was reached and on
 * the words that case produces.
 */

import { describe, expect, it } from "bun:test";
import { checkHub, explainHub, summariseHub } from "./hub-check";

/** A name that cannot resolve, standing in for a quick tunnel whose hub has stopped. */
const GONE = "https://quartet-no-such-tunnel-ever.trycloudflare.com";

describe("asking a hub why it is not answering", () => {
  it("calls a name that does not resolve gone, not merely quiet", async () => {
    expect(await checkHub(GONE)).toEqual({ kind: "gone" });
  });

  it("calls a live port with nothing listening refused, so waiting is still the advice", async () => {
    // Bound and released, so the port is real and certainly closed.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    server.stop(true);

    expect(await checkHub(`http://127.0.0.1:${String(port)}`)).toEqual({ kind: "refused" });
  });

  it("does not take something that answers for a hub", async () => {
    const parked = Bun.serve({ port: 0, fetch: () => new Response("<html>for sale</html>") });
    try {
      expect(await checkHub(`http://127.0.0.1:${String(parked.port)}`)).toEqual({ kind: "not-a-hub" });
    } finally {
      parked.stop(true);
    }
  });

  it("accepts a hub that answers /health as one", async () => {
    const hub = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      expect(await checkHub(`http://127.0.0.1:${String(hub.port)}`)).toEqual({ kind: "ok" });
    } finally {
      hub.stop(true);
    }
  });
});

describe("what a person is told", () => {
  it("tells somebody on a dead quick tunnel to go and get the new URL", () => {
    const said = explainHub(GONE, { kind: "gone" });
    expect(said.join(" ")).toContain("--hub");
    // Never sends somebody hunting for a mistake they did not make.
    expect(said.join(" ")).not.toContain("typos");
    // One line. The verdict is already on the line above this one, and anybody who wanted an
    // essay on cloudflare would not be reading an error message.
    expect(said).toHaveLength(1);
  });

  it("does say typo for an ordinary name that does not resolve", () => {
    expect(explainHub("https://hub.example.com", { kind: "gone" }).join(" ")).toContain("typos");
    expect(explainHub("https://hub.example.com", { kind: "gone" })).toHaveLength(1);
  });

  it("tells somebody whose hub is merely down to wait, not to go looking for a URL", () => {
    const said = explainHub(GONE, { kind: "silent" }).join(" ");
    expect(said).toContain("trying again");
    expect(said).not.toContain("--hub");
  });

  it("summarises a dead quick tunnel in one line that still names the fix", () => {
    const line = summariseHub(GONE, { kind: "gone" });
    expect(line).toContain("--hub");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("says nothing at all about a hub that is fine", () => {
    expect(explainHub(GONE, { kind: "ok" })).toEqual([]);
    expect(summariseHub(GONE, { kind: "ok" })).toBe("");
  });
});

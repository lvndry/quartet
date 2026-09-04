/**
 * @fileoverview That two identities on one host cannot land on the same webhook name.
 *
 * The bug this guards was not a crash. Every identity defaulted to the name `quartet`, so
 * each `connect` quietly took over the previous one's webhook entry — repointing its agent
 * and, because a minted token overwrites the keyring entry keyed by that name, killing the
 * token it had saved. The symptom was a 401 on every turn, in an identity nobody had
 * touched, blamed on the daemon.
 */

import { describe, expect, test } from "bun:test";
import { defaultWebhookName, webhookTokenEnvVar } from "./jazz";

describe("defaultWebhookName", () => {
  test("gives distinct handles distinct names", () => {
    const handles = ["mira", "bloom", "clyde", "arkemis", "otto", "wurse"];
    const names = handles.map(defaultWebhookName);
    expect(new Set(names).size).toBe(handles.length);
  });

  test("never returns the old shared name for a real handle", () => {
    for (const handle of ["mira", "quartet", "Quartet"]) {
      expect(defaultWebhookName(handle)).not.toBe("quartet");
    }
  });

  test("keeps the name usable as a URL segment and a token env var", () => {
    const name = defaultWebhookName("Mira O'Brien-42");
    expect(name).toBe("quartet-mira-o-brien-42");
    expect(encodeURIComponent(name)).toBe(name);
    expect(webhookTokenEnvVar(name)).toBe("JAZZ_WEBHOOK_TOKEN_QUARTET_MIRA_O_BRIEN_42");
  });

  test("does not leave a trailing or doubled separator", () => {
    expect(defaultWebhookName("-mira-")).toBe("quartet-mira");
    expect(defaultWebhookName("a  b")).toBe("quartet-a-b");
  });

  test("handles differing only in case are one identity, not two names", () => {
    expect(defaultWebhookName("Mira")).toBe(defaultWebhookName("mira"));
  });

  // Reachable only before a handle is claimed, which `connect` does before it asks about
  // the daemon — so no webhook is ever written under this.
  test("falls back to the bare name when there is no handle yet", () => {
    expect(defaultWebhookName(undefined)).toBe("quartet");
    expect(defaultWebhookName("")).toBe("quartet");
    expect(defaultWebhookName("!!")).toBe("quartet");
  });
});

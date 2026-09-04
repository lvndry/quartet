/**
 * @fileoverview The screen a scanned pairing code lands on.
 *
 * Deliberately the only part of the app that renders without a credential, because a device
 * that had one would not be here. It asks for two things — the code, and a name for this
 * device — and the name matters: a revocation list reading "a device, a device, a device" is
 * a list nobody can act on, which makes it not much of a control.
 */

import { useState } from "react";

export default function Pairing(): React.JSX.Element {
  const fromUrl = new URL(window.location.href).searchParams.get("code") ?? "";
  const [code, setCode] = useState(fromUrl.toUpperCase());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pairing, setPairing] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPairing(true);
    setError(undefined);

    const response = await fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name }),
    }).catch(() => undefined);

    if (response === undefined) {
      setPairing(false);
      setError("could not reach quartet. Is the bridge still running?");
      return;
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      setPairing(false);
      setError(detail?.error ?? `pairing failed (${String(response.status)})`);
      return;
    }
    // Straight to the app, and off a URL that still has a spent code in it.
    window.location.replace("/");
  }

  return (
    <div className="pairing">
      <form className="pairing-card" onSubmit={(event) => void submit(event)}>
        <div className="wordmark">
          Quar<span>tet</span>
        </div>
        <h1>Pair this device</h1>
        <p className="pairing-lede">
          This gives the device you are holding the same control over your agent as the machine
          it runs on. You can take it back at any time from Your agents → Devices.
        </p>

        <label htmlFor="pairing-code">Code from the terminal</label>
        <input
          id="pairing-code"
          className="pairing-code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder="ABCD2345"
          required
        />

        <label htmlFor="pairing-name">What is this device?</label>
        <input
          id="pairing-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="my phone"
          required
        />

        {error !== undefined && <p className="pairing-error">{error}</p>}

        <button type="submit" disabled={pairing || code.length === 0 || name.trim().length === 0}>
          {pairing ? "pairing…" : "Pair this device"}
        </button>
      </form>
    </div>
  );
}

/**
 * @fileoverview Which devices can drive this agent, and taking that back.
 *
 * Lives beside the agent roster because it answers the same question — what is acting as me
 * — and because full parity means a paired phone sees this list too. Revoking from the phone
 * you are about to hand over is the one revocation somebody in that situation can actually
 * perform.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { call, read } from "./store";

interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastSeenAt?: string;
}

interface Offer {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
}

/** "3 minutes ago", near enough. A device list needs recency, not a timestamp. */
function ago(iso: string | undefined): string {
  if (iso === undefined) return "not since pairing";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hours ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

export function Devices(): React.JSX.Element {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [offer, setOffer] = useState<Offer | undefined>();
  const [qr, setQr] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [remaining, setRemaining] = useState(0);

  const refresh = useCallback(async () => {
    const result = await read<{ devices: PairedDevice[] }>("devices");
    if ("refused" in result) {
      setError(result.refused.error);
      return;
    }
    setError(undefined);
    setDevices(result.value.devices);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A code that has silently expired is worse than no code, because somebody is standing
  // there typing it. The countdown is the honest version, and clearing it at zero means the
  // screen never shows a code that will not work.
  useEffect(() => {
    if (offer === undefined) return;
    const tick = (): void => {
      const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setOffer(undefined);
        setQr(undefined);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [offer]);

  async function startPairing(): Promise<void> {
    const result = await read<Offer>("devices/offer");
    if ("refused" in result) {
      setError(result.refused.error);
      return;
    }
    setOffer(result.value);
    setQr(await QRCode.toDataURL(result.value.url, { margin: 1, width: 320 }));
  }

  async function stopPairing(): Promise<void> {
    setOffer(undefined);
    setQr(undefined);
    await call("devices/cancel", {});
  }

  async function revoke(device: PairedDevice): Promise<void> {
    const failed = await call("devices/revoke", { deviceId: device.id });
    if (failed !== undefined) {
      setError(failed);
      return;
    }
    await refresh();
  }

  const local = offer !== undefined && offer.url.startsWith("http://localhost");

  return (
    <div className="devices">
      <div className="dash-group">Devices</div>

      {error !== undefined && <p className="dash-wrong">{error}</p>}

      {devices.length === 0 && offer === undefined && (
        <p className="dash-hint">
          Only this machine can drive your agent. Pair a phone to change that.
        </p>
      )}

      {devices.map((device) => (
        <div className="device-row" key={device.id}>
          <span className="row-main">
            <span className="dash-row-title">{device.name}</span>
            <span className="row-sub">last used {ago(device.lastSeenAt)}</span>
          </span>
          <button className="btn danger" type="button" onClick={() => void revoke(device)}>
            Revoke
          </button>
        </div>
      ))}

      {offer === undefined ? (
        <button className="btn dash-new" type="button" onClick={() => void startPairing()}>
          Pair a device
        </button>
      ) : (
        <div className="pairing-offer">
          {qr !== undefined && <img src={qr} alt="" className="pairing-qr" />}
          <p className="dash-hint">Scan this, then type the code.</p>
          <div className="pairing-offer-code">{offer.code}</div>
          <p className="dash-hint">
            Good for {String(remaining)}s, and for one device.
          </p>
          {local && (
            <p className="dash-wrong">
              This address only works on this machine. Restart the bridge with{" "}
              <code>--expose</code> so a phone has something it can reach.
            </p>
          )}
          <button className="btn" type="button" onClick={() => void stopPairing()}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

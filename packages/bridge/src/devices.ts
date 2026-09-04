/**
 * @fileoverview Which devices may drive this agent, and how one earns that.
 *
 * Until a device can pair, reaching the app meant being at the machine — physical access was
 * doing the work an access-control system usually does. This is what replaces it, so the
 * pieces here are load-bearing in a way the local token never was: see
 * `docs/design/paired-devices.md`.
 *
 * Pairing is always initiated from the machine. There is no "request access" flow, because
 * approving one is a decision made under exactly the social pressure that makes people
 * approve things they should not.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Unambiguous when read off a screen and typed on a phone: no `0`/`O`, no `1`/`I`/`L`.
 *
 * Thirty-two symbols over eight characters is forty bits, which matters only alongside the
 * two-minute expiry and the attempt limit below — none of the three is sufficient alone.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

/** Long enough that the expiry is what ends a pairing window, not the person's typing. */
export const PAIRING_TTL_MS = 120_000;

/**
 * Wrong codes tolerated before the offer is burned.
 *
 * Ten, not three: a person mistyping their third character should not have to walk back to
 * the terminal. Forty bits inside two minutes needs far more than ten guesses anyway, so the
 * limit is here to make the brute-force case impossible rather than merely expensive.
 */
const MAX_ATTEMPTS = 10;

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastSeenAt?: string;
}

/**
 * A paired device as it is written to disk.
 *
 * The token is stored as a SHA-256 digest and never in the clear. `config.json` is already
 * owner-only, so this is defence against the file being read some other way — a backup, a
 * synced directory, a support paste — where a bearer token that drives an agent is a worse
 * thing to leak than the fact that a device exists.
 */
export interface StoredDevice extends PairedDevice {
  readonly tokenHash: string;
}

export interface PairingOffer {
  readonly code: string;
  readonly expiresAt: number;
}

export type RedeemResult =
  | { readonly kind: "ok"; readonly device: PairedDevice; readonly token: string }
  | { readonly kind: "no-offer" }
  | { readonly kind: "expired" }
  | { readonly kind: "wrong-code"; readonly attemptsLeft: number }
  | { readonly kind: "burned" };

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compare digests without leaking how far they matched.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so the lengths
 * are checked first — and both sides here are hex digests of a fixed width, which makes that
 * check itself constant with respect to the secret.
 */
function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function generateCode(): string {
  // Rejection-free because 31 does not divide 256 evenly only in the last partial block —
  // drawing a byte per character and taking it modulo the alphabet skews by under 1%, which
  // costs a fraction of a bit against a code that already has an expiry and an attempt cap.
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/**
 * The paired devices, the one pairing code that may be outstanding, and nothing else.
 *
 * Persistence is a callback rather than a config import so the whole thing is testable
 * without a filesystem, and so the caller decides when a write is worth making.
 */
export class DeviceRegistry {
  private devices: StoredDevice[];
  private offer: { code: string; expiresAt: number; attempts: number } | undefined;

  private readonly revocationListeners: ((deviceId: string) => void)[] = [];

  constructor(
    initial: readonly StoredDevice[],
    private readonly persist: (devices: readonly StoredDevice[]) => Promise<void>,
  ) {
    this.devices = [...initial];
  }

  /**
   * Be told when a device loses access, so whatever it has open can be closed.
   *
   * A listener rather than a constructor argument because the thing that needs to react —
   * the set of live browser sockets — is created by the server, which is handed this registry
   * rather than the other way round.
   */
  onRevokedDevice(listener: (deviceId: string) => void): void {
    this.revocationListeners.push(listener);
  }

  /**
   * Open a pairing window, replacing any that was already open.
   *
   * Replacing rather than refusing: somebody who runs `pair` twice wants the code on the
   * screen in front of them to be the one that works, and the older code becoming useless is
   * the safe direction to resolve that.
   */
  offerPairing(now = Date.now()): PairingOffer {
    const code = generateCode();
    this.offer = { code, expiresAt: now + PAIRING_TTL_MS, attempts: 0 };
    return { code, expiresAt: this.offer.expiresAt };
  }

  pendingOffer(now = Date.now()): PairingOffer | undefined {
    if (this.offer === undefined) return undefined;
    if (this.offer.expiresAt <= now) {
      this.offer = undefined;
      return undefined;
    }
    return { code: this.offer.code, expiresAt: this.offer.expiresAt };
  }

  cancelPairing(): void {
    this.offer = undefined;
  }

  /**
   * Spend the outstanding code for a device token.
   *
   * The offer is cleared on success and on running out of attempts, so one code pairs one
   * device. A code that stays live after it has been used is a credential lying around.
   */
  async redeem(code: string, name: string, now = Date.now()): Promise<RedeemResult> {
    const offer = this.offer;
    if (offer === undefined) return { kind: "no-offer" };
    if (offer.expiresAt <= now) {
      this.offer = undefined;
      return { kind: "expired" };
    }

    const supplied = code.trim().toUpperCase().replaceAll(/[\s-]/g, "");
    if (supplied !== offer.code) {
      offer.attempts += 1;
      if (offer.attempts >= MAX_ATTEMPTS) {
        this.offer = undefined;
        return { kind: "burned" };
      }
      return { kind: "wrong-code", attemptsLeft: MAX_ATTEMPTS - offer.attempts };
    }

    this.offer = undefined;
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = {
      id: `dev_${randomBytes(8).toString("hex")}`,
      name: name.trim().length > 0 ? name.trim().slice(0, 60) : "a device",
      pairedAt: new Date(now).toISOString(),
      tokenHash: digest(token),
    };
    this.devices = [...this.devices, device];
    await this.persist(this.devices);
    return { kind: "ok", device: strip(device), token };
  }

  /** The device this token belongs to, or undefined. Does not record a sighting. */
  verify(token: string): PairedDevice | undefined {
    if (token.length === 0) return undefined;
    const supplied = digest(token);
    const found = this.devices.find((device) => digestsMatch(device.tokenHash, supplied));
    return found === undefined ? undefined : strip(found);
  }

  /**
   * Note that a device is currently being used, for the list in the app.
   *
   * Written at most once a minute per device: this is called on every authorized request, and
   * a config rewrite per request would turn a page refresh into a burst of disk writes.
   */
  async touch(deviceId: string, now = Date.now()): Promise<void> {
    const index = this.devices.findIndex((device) => device.id === deviceId);
    const device = this.devices[index];
    if (device === undefined) return;
    const last = device.lastSeenAt === undefined ? 0 : Date.parse(device.lastSeenAt);
    if (now - last < 60_000) return;
    const updated = [...this.devices];
    updated[index] = { ...device, lastSeenAt: new Date(now).toISOString() };
    this.devices = updated;
    await this.persist(this.devices);
  }

  list(): PairedDevice[] {
    return this.devices.map(strip);
  }

  /**
   * Take a device's access away, now.
   *
   * `onRevoked` closes whatever that device currently has open. Refusing the next request
   * while an existing socket keeps streaming the room is not revocation, and a phone that is
   * no longer in your pocket is the case this exists for.
   */
  async revoke(deviceId: string): Promise<boolean> {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== deviceId);
    if (this.devices.length === before) return false;
    await this.persist(this.devices);
    for (const listener of this.revocationListeners) listener(deviceId);
    return true;
  }
}

function strip(device: StoredDevice): PairedDevice {
  const { tokenHash: _tokenHash, ...rest } = device;
  return rest;
}

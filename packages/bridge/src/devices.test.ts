import { describe, expect, test } from "bun:test";
import { DeviceRegistry, generateCode, PAIRING_TTL_MS, type StoredDevice } from "./devices";

function registry(initial: readonly StoredDevice[] = []): {
  devices: DeviceRegistry;
  saved: () => readonly StoredDevice[];
} {
  let saved: readonly StoredDevice[] = initial;
  const devices = new DeviceRegistry(initial, async (updated) => {
    saved = updated;
    await Promise.resolve();
  });
  return { devices, saved: () => saved };
}

describe("pairing codes", () => {
  test("avoid the characters that get misread off a screen", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(generateCode()).not.toMatch(/[01OIL]/);
    }
  });

  test("do not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(seen.size).toBe(200);
  });
});

describe("redeeming", () => {
  test("the right code pairs a device and persists it", async () => {
    const { devices, saved } = registry();
    const offer = devices.offerPairing();

    const result = await devices.redeem(offer.code, "Landry's phone");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.device.name).toBe("Landry's phone");
    expect(saved()).toHaveLength(1);
    expect(devices.verify(result.token)?.id).toBe(result.device.id);
  });

  test("the token is never stored in the clear", async () => {
    const { devices, saved } = registry();
    const offer = devices.offerPairing();
    const result = await devices.redeem(offer.code, "phone");
    if (result.kind !== "ok") throw new Error("expected a pairing");

    expect(JSON.stringify(saved())).not.toContain(result.token);
  });

  test("a code is spent once, so it cannot pair a second device", async () => {
    const { devices } = registry();
    const offer = devices.offerPairing();

    expect((await devices.redeem(offer.code, "first")).kind).toBe("ok");
    expect((await devices.redeem(offer.code, "second")).kind).toBe("no-offer");
    expect(devices.list()).toHaveLength(1);
  });

  test("is forgiving of how the code was typed", async () => {
    const { devices } = registry();
    const offer = devices.offerPairing();
    const messy = ` ${offer.code.toLowerCase().slice(0, 4)}-${offer.code.toLowerCase().slice(4)} `;

    expect((await devices.redeem(messy, "phone")).kind).toBe("ok");
  });

  test("an expired offer pairs nothing", async () => {
    const { devices } = registry();
    const start = Date.now();
    const offer = devices.offerPairing(start);

    const result = await devices.redeem(offer.code, "phone", start + PAIRING_TTL_MS + 1);
    expect(result.kind).toBe("expired");
    expect(devices.list()).toHaveLength(0);
  });

  test("burns the offer rather than allowing unlimited guesses", async () => {
    const { devices } = registry();
    const offer = devices.offerPairing();

    const kinds: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      kinds.push((await devices.redeem("WRONGWRO", "phone")).kind);
    }

    expect(kinds.at(-1)).toBe("burned");
    // And the real code is worthless afterwards, which is the point of burning it.
    expect((await devices.redeem(offer.code, "phone")).kind).toBe("no-offer");
  });

  test("a fresh offer replaces the one before it", async () => {
    const { devices } = registry();
    const first = devices.offerPairing();
    const second = devices.offerPairing();

    expect((await devices.redeem(first.code, "phone")).kind).toBe("wrong-code");
    expect((await devices.redeem(second.code, "phone")).kind).toBe("ok");
  });
});

describe("verifying", () => {
  test("an unknown token is nobody", async () => {
    const { devices } = registry();
    const offer = devices.offerPairing();
    await devices.redeem(offer.code, "phone");

    expect(devices.verify("00".repeat(32))).toBeUndefined();
    expect(devices.verify("")).toBeUndefined();
  });
});

describe("revoking", () => {
  test("drops the device, persists, and tells whoever is listening", async () => {
    const { devices, saved } = registry();
    const offer = devices.offerPairing();
    const paired = await devices.redeem(offer.code, "phone");
    if (paired.kind !== "ok") throw new Error("expected a pairing");

    const closed: string[] = [];
    devices.onRevokedDevice((deviceId) => closed.push(deviceId));

    expect(await devices.revoke(paired.device.id)).toBe(true);
    expect(closed).toEqual([paired.device.id]);
    expect(saved()).toHaveLength(0);
    // The token stops working immediately, not on next connect.
    expect(devices.verify(paired.token)).toBeUndefined();
  });

  test("revoking something that is not there is not an error", async () => {
    const { devices } = registry();
    expect(await devices.revoke("dev_nothing")).toBe(false);
  });
});

describe("last seen", () => {
  test("is recorded, then left alone for a while", async () => {
    const { devices } = registry();
    const offer = devices.offerPairing();
    const paired = await devices.redeem(offer.code, "phone");
    if (paired.kind !== "ok") throw new Error("expected a pairing");

    const start = Date.now();
    await devices.touch(paired.device.id, start);
    const first = devices.list()[0]?.lastSeenAt;
    expect(first).toBeDefined();

    // A page refresh a second later must not mean another config write.
    await devices.touch(paired.device.id, start + 1_000);
    expect(devices.list()[0]?.lastSeenAt).toBe(first);

    await devices.touch(paired.device.id, start + 61_000);
    expect(devices.list()[0]?.lastSeenAt).not.toBe(first);
  });
});

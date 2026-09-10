import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REGISTRY_URL,
  announceOptedIn,
  finalizeAnnounceConfig,
  isLocalOrigin,
  originFromUrl,
  publicOriginFromEnv,
  registryTokenFrom,
  registryUrlFrom,
  resolveAnnounceIntent,
} from "./announce";

describe("public origin helpers", () => {
  it("takes the origin from a full URL", () => {
    expect(originFromUrl("https://hub.example.com/join")).toBe("https://hub.example.com");
  });

  it("reads QUARTET_PUBLIC_URL before RAILWAY_PUBLIC_DOMAIN", () => {
    expect(
      publicOriginFromEnv({
        QUARTET_PUBLIC_URL: "https://hub.example.com",
        RAILWAY_PUBLIC_DOMAIN: "other.up.railway.app",
      }),
    ).toBe("https://hub.example.com");
    expect(publicOriginFromEnv({ RAILWAY_PUBLIC_DOMAIN: "hub.up.railway.app" })).toBe(
      "https://hub.up.railway.app",
    );
  });

  it("treats loopback as unlistable", () => {
    expect(isLocalOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalOrigin("http://localhost:8080")).toBe(true);
    expect(isLocalOrigin("https://trycloudflare.com")).toBe(false);
  });
});

describe("registry defaults", () => {
  it("bakes in Quartet's public registry unless overridden", () => {
    expect(registryUrlFrom(undefined, {})).toBe(DEFAULT_REGISTRY_URL);
    expect(registryUrlFrom("https://mine.example/", {})).toBe("https://mine.example");
    expect(registryUrlFrom(undefined, { QUARTET_REGISTRY_URL: "https://env.example/" })).toBe(
      "https://env.example",
    );
  });

  it("only carries a token when one was set", () => {
    expect(registryTokenFrom(undefined, {})).toBeUndefined();
    expect(registryTokenFrom("flag-token", {})).toBe("flag-token");
    expect(registryTokenFrom(undefined, { QUARTET_HUB_REGISTRY_TOKEN: "env-token" })).toBe("env-token");
  });

  it("opts in from --announce, QUARTET_ANNOUNCE, or a set QUARTET_REGISTRY_URL", () => {
    expect(announceOptedIn(false, {})).toBe(false);
    expect(announceOptedIn(true, {})).toBe(true);
    expect(announceOptedIn(false, { QUARTET_ANNOUNCE: "1" })).toBe(true);
    expect(announceOptedIn(false, { QUARTET_REGISTRY_URL: DEFAULT_REGISTRY_URL })).toBe(true);
  });
});

describe("resolveAnnounceIntent", () => {
  it("skips when nobody opted in and the answer is no / unattended", async () => {
    expect(
      await resolveAnnounceIntent({
        announceFlag: false,
        wantsTunnel: false,
        env: {},
        ask: async () => undefined,
      }),
    ).toBeUndefined();
    expect(
      await resolveAnnounceIntent({
        announceFlag: false,
        wantsTunnel: false,
        env: {},
        ask: async () => "n",
      }),
    ).toBeUndefined();
  });

  it("uses the baked-in registry and does not ask for a URL when tunnelling", async () => {
    const questions: string[] = [];
    const intent = await resolveAnnounceIntent({
      announceFlag: false,
      wantsTunnel: true,
      env: {},
      ask: async (q) => {
        questions.push(q);
        if (q.includes("public directory")) return "y";
        throw new Error(`unexpected question: ${q}`);
      },
    });
    expect(intent).toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      awaitTunnel: true,
    });
    expect(questions).toHaveLength(1);
  });

  it("keeps Railway unattended hubs working from env alone", async () => {
    const intent = await resolveAnnounceIntent({
      announceFlag: false,
      wantsTunnel: false,
      env: {
        QUARTET_REGISTRY_URL: "https://registry.example",
        QUARTET_HUB_REGISTRY_TOKEN: "secret",
        RAILWAY_PUBLIC_DOMAIN: "afterdark.up.railway.app",
      },
      ask: async () => {
        throw new Error("should not ask when env fully opts in");
      },
    });
    expect(intent).toEqual({
      registryUrl: "https://registry.example",
      token: "secret",
      publicOrigin: "https://afterdark.up.railway.app",
      awaitTunnel: false,
    });
  });

  it("refuses a localhost public URL without a tunnel", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const intent = await resolveAnnounceIntent({
        announceFlag: true,
        publicUrlFlag: "http://127.0.0.1:8080",
        wantsTunnel: false,
        env: {},
        ask: async () => {
          throw new Error("should not ask");
        },
      });
      expect(intent).toBeUndefined();
      expect(warnings.join("\n")).toContain("localhost");
    } finally {
      console.warn = original;
    }
  });
});

describe("finalizeAnnounceConfig", () => {
  it("fills the public origin from the tunnel URL", () => {
    expect(
      finalizeAnnounceConfig(
        { registryUrl: DEFAULT_REGISTRY_URL, awaitTunnel: true },
        "https://abc.trycloudflare.com",
      ),
    ).toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      publicOrigin: "https://abc.trycloudflare.com",
    });
  });

  it("warns and skips when still localhost after the tunnel failed", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(
        finalizeAnnounceConfig({
          registryUrl: DEFAULT_REGISTRY_URL,
          publicOrigin: "http://localhost:8080",
          awaitTunnel: true,
        }),
      ).toBeUndefined();
      expect(warnings.join("\n")).toContain("public URL");
    } finally {
      console.warn = original;
    }
  });
});

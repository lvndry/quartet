import { describe, expect, it } from "bun:test";
import { normalizeHubUrl } from "./hub-url";

describe("normalizeHubUrl", () => {
  it("upgrades http to https for hosted hubs", () => {
    expect(normalizeHubUrl("http://afterdark-production.up.railway.app")).toBe(
      "https://afterdark-production.up.railway.app",
    );
  });

  it("leaves loopback on http", () => {
    expect(normalizeHubUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeHubUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("accepts a bare host as https", () => {
    expect(normalizeHubUrl("afterdark-production.up.railway.app")).toBe(
      "https://afterdark-production.up.railway.app",
    );
  });

  it("strips a trailing slash so handle caches stay keyed one way", () => {
    expect(normalizeHubUrl("https://afterdark-production.up.railway.app/")).toBe(
      "https://afterdark-production.up.railway.app",
    );
  });
});

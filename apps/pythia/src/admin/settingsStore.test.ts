import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./settingsStore.js";

let dir: string;
const fresh = () => new SettingsStore({ filePath: join(dir, "settings.json") });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SettingsStore hub config", () => {
  it("starts empty — no secret, default base URL, hubConfig null", () => {
    const s = fresh();
    expect(s.hasSecret()).toBe(false);
    expect(s.hubBaseUrl()).toBe("https://ancientholdings.eu");
    expect(s.hubConfig()).toBeNull();
  });

  it("returns a HubConfig once a secret is set, stripping a trailing slash", () => {
    const s = fresh();
    s.setHubConfig({ hubBaseUrl: "https://hub.test/", hmacSecret: "deadbeef" });
    expect(s.hasSecret()).toBe(true);
    expect(s.hubConfig()).toEqual({ baseUrl: "https://hub.test", secret: "deadbeef" });
  });

  it("leaves the secret unchanged when hmacSecret is omitted (write-only update)", () => {
    const s = fresh();
    s.setHubConfig({ hmacSecret: "sec1" });
    s.setHubConfig({ hubBaseUrl: "https://other.test" }); // no hmacSecret → keep it
    expect(s.hubConfig()).toEqual({ baseUrl: "https://other.test", secret: "sec1" });
  });

  it("clears the secret on an empty string (disables the feed)", () => {
    const s = fresh();
    s.setHubConfig({ hmacSecret: "sec1" });
    s.setHubConfig({ hmacSecret: "" });
    expect(s.hasSecret()).toBe(false);
    expect(s.hubConfig()).toBeNull();
  });

  it("persists across reloads (survives a restart)", () => {
    fresh().setHubConfig({ hubBaseUrl: "https://hub.test", hmacSecret: "abc123" });
    const reloaded = fresh();
    expect(reloaded.hubConfig()).toEqual({ baseUrl: "https://hub.test", secret: "abc123" });
  });
});

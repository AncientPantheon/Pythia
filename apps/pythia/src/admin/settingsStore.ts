import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HubConfig } from "../hub/serviceClient.js";

/**
 * Runtime, admin-managed settings — set from the `ancient`-gated admin UI instead
 * of the deploy env, so an operator activates the hub feed from the website rather
 * than editing a file over SSH. File-backed on the mounted volume, atomic
 * temp+rename (modelled on `connectors/store.ts`).
 *
 * The hub HMAC secret is stored here as PLAINTEXT — it is a bearer credential
 * Pythia must USE to sign feed requests, so it cannot be hashed. The file lives on
 * the container-private `/data` volume (never the repo); the UI treats the secret
 * write-only (masked, never returned to the browser).
 */
export interface HubSettings {
  hubBaseUrl?: string;
  hmacSecret?: string;
}

const DEFAULT_HUB_BASE_URL = "https://ancientholdings.eu";

export class SettingsStore {
  private settings: HubSettings = {};
  private readonly filePath: string;

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") this.settings = parsed as HubSettings;
    } catch {
      // Absent/invalid → empty; first write materialises it.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** The configured base URL for display (default when unset). Never leaks the secret. */
  hubBaseUrl(): string {
    return this.settings.hubBaseUrl?.trim() || DEFAULT_HUB_BASE_URL;
  }

  /** Whether an HMAC secret is stored (the feed can be enabled from settings). */
  hasSecret(): boolean {
    return !!this.settings.hmacSecret?.trim();
  }

  /**
   * Update the hub feed settings. `undefined` fields are left unchanged; an empty
   * string clears that field. Persists atomically.
   */
  setHubConfig(patch: { hubBaseUrl?: string; hmacSecret?: string }): void {
    if (patch.hubBaseUrl !== undefined) {
      const v = patch.hubBaseUrl.trim();
      this.settings.hubBaseUrl = v || undefined;
    }
    if (patch.hmacSecret !== undefined) {
      const v = patch.hmacSecret.trim();
      this.settings.hmacSecret = v || undefined;
    }
    this.persist();
  }

  /**
   * The effective {@link HubConfig} from settings, or `null` when no secret is
   * stored (the caller then falls back to the deploy env).
   */
  hubConfig(): HubConfig | null {
    const secret = this.settings.hmacSecret?.trim();
    if (!secret) return null;
    return { baseUrl: this.hubBaseUrl().replace(/\/+$/, ""), secret };
  }
}

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HubConfig } from "../hub/serviceClient.js";
import type { SealedVault, VaultStatus } from "./sealedVault.js";

/** The name the hub HMAC secret is sealed under inside the vault. */
const HUB_SECRET_NAME = "hubHmacSecret";

/** The vault status the Security admin panel renders, plus whether the store is
 * currently operating in plaintext-fallback (no master key) rather than sealing. */
export interface SecurityStatus extends VaultStatus {
  plaintextFallback: boolean;
}

/**
 * Runtime, admin-managed settings — set from the `ancient`-gated admin UI instead
 * of the deploy env, so an operator activates the hub feed from the website rather
 * than editing a file over SSH. File-backed on the mounted volume, atomic
 * temp+rename (modelled on `connectors/store.ts`).
 *
 * The hub HMAC secret is a bearer credential Pythia must USE to sign feed requests,
 * so it cannot be hashed. When a {@link SealedVault} is injected AND unlocked (a
 * `PYTHIA_MASTER_KEY` is set), the secret is SEALED at rest in the vault and never
 * written to this file — and any legacy plaintext secret found here is migrated
 * into the vault and stripped on load. With no master key (dev), it falls back to
 * plaintext in this file, exactly as before. Either way the file lives on the
 * container-private `/data` volume (never the repo); the UI treats the secret
 * write-only (masked, never returned to the browser).
 */
export interface HubSettings {
  hubBaseUrl?: string;
  hmacSecret?: string;
  /** Whether Pythia reports served usage to the hub (drives minting). Default ON;
   * only `false` when the ancient admin explicitly turns it off. */
  reportToHub?: boolean;
}

const DEFAULT_HUB_BASE_URL = "https://ancientholdings.eu";

export class SettingsStore {
  private settings: HubSettings = {};
  private readonly filePath: string;
  private readonly vault?: SealedVault;

  constructor(opts: { filePath: string; vault?: SealedVault }) {
    this.filePath = opts.filePath;
    this.vault = opts.vault;
    this.load();
    this.migratePlaintextIntoVault();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") this.settings = parsed as HubSettings;
    } catch {
      // Absent/invalid → empty; first write materialises it.
    }
  }

  /** True when the store is sealing (a vault is injected and its master key is set). */
  private sealing(): boolean {
    return this.vault?.isUnlocked() === true;
  }

  /** One-time on load: if we can seal and a legacy plaintext secret is present in
   * settings.json, move it into the vault and strip it from the plaintext file. */
  private migratePlaintextIntoVault(): void {
    const legacy = this.settings.hmacSecret?.trim();
    if (this.sealing() && legacy) {
      this.vault!.set(HUB_SECRET_NAME, legacy);
      this.settings.hmacSecret = undefined;
      this.persist();
    }
  }

  /** The effective secret regardless of storage mode: the vault when sealing, else
   * the plaintext field. `null`/empty when unset (or vault locked / wrong key). */
  private effectiveSecret(): string | undefined {
    if (this.sealing()) return this.vault!.get(HUB_SECRET_NAME) ?? undefined;
    return this.settings.hmacSecret?.trim() || undefined;
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
    return !!this.effectiveSecret();
  }

  /**
   * Update the hub feed settings. `undefined` fields are left unchanged; an empty
   * string clears that field. The base URL always lives in settings.json; the
   * secret is sealed in the vault when sealing, else stored plaintext. Persists
   * atomically.
   */
  setHubConfig(patch: { hubBaseUrl?: string; hmacSecret?: string }): void {
    if (patch.hubBaseUrl !== undefined) {
      const v = patch.hubBaseUrl.trim();
      this.settings.hubBaseUrl = v || undefined;
    }
    if (patch.hmacSecret !== undefined) {
      const v = patch.hmacSecret.trim();
      if (this.sealing()) {
        if (v) this.vault!.set(HUB_SECRET_NAME, v);
        else this.vault!.delete(HUB_SECRET_NAME);
        this.settings.hmacSecret = undefined; // never keep a plaintext copy when sealing.
      } else {
        this.settings.hmacSecret = v || undefined;
      }
    }
    this.persist();
  }

  /** The vault status (for the ancient-gated Security panel) + whether the store is
   * currently in plaintext-fallback (no master key) rather than sealing. */
  securityStatus(): SecurityStatus {
    const base: VaultStatus = this.vault
      ? this.vault.status()
      : { mode: "empty", unlocked: false, fingerprint: null, sealedCount: 0, names: [] };
    return { ...base, plaintextFallback: !this.sealing() };
  }

  /** Whether Pythia should report usage to the hub (default ON — reporting is the
   * normal behaviour; only an explicit `false` turns it off). */
  reportEnabled(): boolean {
    return this.settings.reportToHub !== false;
  }

  /** Turn hub usage reporting on/off. Persists atomically. */
  setReportEnabled(on: boolean): void {
    this.settings.reportToHub = on;
    this.persist();
  }

  /**
   * The effective {@link HubConfig} from settings, or `null` when no secret is
   * stored (the caller then falls back to the deploy env).
   */
  hubConfig(): HubConfig | null {
    const secret = this.effectiveSecret();
    if (!secret) return null;
    return { baseUrl: this.hubBaseUrl().replace(/\/+$/, ""), secret };
  }
}

import { emptySnapshot } from "@ancientpantheon/codex/ouronet";
import type {
  CodexAdapter,
  CodexSnapshot,
  IStoaChainSeed,
  IOuroAccount,
  IPureKeypair,
  AddressBookEntry,
  WatchListEntry,
  UiSettings,
  IConsumerSettings,
  ICodexIdentity,
  DeviceVariant,
} from "@ancientpantheon/codex/ouronet";

/**
 * PythiaServerCodexAdapter — the `@ancientpantheon/codex` adapter that persists Pythia's
 * OWN operator codex SERVER-SIDE, master-key sealed via the canonical vault (Topic 1),
 * instead of browser localStorage. Ported from Mnemosyne's server adapter; the only change
 * is the route base (`/admin/codex`, Pythia's ancient-gated codex plane).
 *
 * Runs in the browser (the package's CodexProvider only calls the adapter client-side).
 * Every write proxies to `/admin/codex`, which seals the whole snapshot. Per-entry secrets
 * are already encrypted under the codex password before they reach the adapter, so it never
 * sees plaintext key material — the master-key seal is a second at-rest layer. With no
 * snapshot yet, `loadAll()` returns `emptySnapshot()` so the UI mounts empty and the ancient
 * populates it live.
 */

const SNAPSHOT_URL = "/admin/codex";

export class PythiaServerCodexAdapter implements CodexAdapter {
  readonly name = "pythia-server";
  private readonly deviceVariant: DeviceVariant;
  private snap: CodexSnapshot | null = null;

  constructor(deviceVariant: DeviceVariant = "main") {
    this.deviceVariant = deviceVariant;
  }

  async loadAll(): Promise<CodexSnapshot> {
    const res = await fetch(SNAPSHOT_URL, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b: { error?: string }) => b?.error)
        .catch(() => "");
      throw new Error(`${this.name}: load failed (HTTP ${res.status})${detail ? ` — ${detail}` : ""}`);
    }
    const body = (await res.json()) as { backup?: string | null };
    this.snap = body.backup ? (JSON.parse(body.backup) as CodexSnapshot) : emptySnapshot(this.deviceVariant);
    return this.snap;
  }

  async saveAll(snapshot: CodexSnapshot): Promise<void> {
    this.snap = snapshot;
    const res = await fetch(SNAPSHOT_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup: JSON.stringify(snapshot) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${this.name}: save failed (HTTP ${res.status}) ${detail}`);
    }
  }

  private async current(): Promise<CodexSnapshot> {
    return this.snap ?? this.loadAll();
  }

  async saveStoaChainSeeds(seeds: IStoaChainSeed[]): Promise<void> {
    await this.saveAll({ ...(await this.current()), kadenaSeeds: seeds });
  }
  async saveOuroAccounts(accounts: IOuroAccount[]): Promise<void> {
    await this.saveAll({ ...(await this.current()), ouroAccounts: accounts });
  }
  async savePureKeypairs(keypairs: IPureKeypair[]): Promise<void> {
    await this.saveAll({ ...(await this.current()), pureKeypairs: keypairs });
  }
  async saveAddressBook(entries: AddressBookEntry[]): Promise<void> {
    await this.saveAll({ ...(await this.current()), addressBook: entries });
  }
  async saveWatchList(entries: WatchListEntry[]): Promise<void> {
    await this.saveAll({ ...(await this.current()), watchList: entries });
  }
  async saveUiSettings(settings: UiSettings): Promise<void> {
    await this.saveAll({ ...(await this.current()), uiSettings: settings });
  }
  async saveConsumerSettings(consumerSettings: Record<string, IConsumerSettings>): Promise<void> {
    await this.saveAll({ ...(await this.current()), consumerSettings });
  }
  async saveCodexIdentity(identity: ICodexIdentity | undefined): Promise<void> {
    await this.saveAll({ ...(await this.current()), codexIdentity: identity });
  }

  async touch(
    deviceVariant: DeviceVariant,
  ): Promise<{ lastUpdatedAt: string; lastUpdatedDevice: DeviceVariant }> {
    const lastUpdatedAt = new Date().toISOString();
    await this.saveAll({ ...(await this.current()), lastUpdatedAt, lastUpdatedDevice: deviceVariant });
    return { lastUpdatedAt, lastUpdatedDevice: deviceVariant };
  }

  async getSchemaVersion(): Promise<number> {
    return (await this.current()).schemaVersion;
  }
  async setSchemaVersion(v: number): Promise<void> {
    await this.saveAll({ ...(await this.current()), schemaVersion: v });
  }

  // The whole snapshot is already master-key sealed; no separate encrypted sidecar.
  async loadUiSettingsEncrypted(_password: string): Promise<UiSettings | null> {
    return null;
  }
  async saveUiSettingsEncrypted(_settings: UiSettings, _password: string): Promise<void> {
    /* no-op */
  }

  async clearAll(): Promise<void> {
    const res = await fetch(SNAPSHOT_URL, { method: "DELETE", credentials: "same-origin" });
    if (!res.ok) throw new Error(`${this.name}: clear failed (HTTP ${res.status})`);
    this.snap = emptySnapshot(this.deviceVariant);
  }
}

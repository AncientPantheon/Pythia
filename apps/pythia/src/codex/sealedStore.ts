import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { readMasterKey, sealWithKey, unsealWithKey } from "./vault.js";

/**
 * The canonical Pantheonic vault (`automaton/02` §3, the file variant Mnemosyne
 * uses): named secrets sealed as `<name>.sealed` files under one directory, through
 * the ONE shared {@link sealWithKey}/{@link unsealWithKey}. Server-held auto-unlock —
 * the master key comes from `PYTHIA_MASTER_KEY` (via {@link readMasterKey}); no human
 * prompt. Rotation is a generic re-seal over every file (canonical rule #3), so a
 * secret type added later is covered for free.
 *
 * Requires `ensureSodiumReady()` before use (construct after it at boot).
 */

export type VaultMode = "sealed" | "locked" | "empty";

export interface SealedStoreStatus {
  /** `empty` = no master key; `sealed` = key present + all entries decrypt; `locked`
   * = key present but an entry won't decrypt (key mismatch). */
  mode: VaultMode;
  unlocked: boolean;
  /** First 8 hex of sha256(masterKey) — identifies WHICH key is loaded, never it. */
  fingerprint: string | null;
  sealedCount: number;
  names: string[];
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface SealedStoreOpts {
  dir: string;
  /** Returns the 32-byte master key, or throws when none is set. Defaults to the
   * env key ({@link readMasterKey}); injectable for tests + rotation. */
  keyProvider?: () => Uint8Array;
}

export class SealedStore {
  private readonly dir: string;
  private readonly keyProvider: () => Uint8Array;

  constructor(opts: SealedStoreOpts) {
    this.dir = opts.dir;
    this.keyProvider = opts.keyProvider ?? readMasterKey;
  }

  private pathFor(name: string): string {
    if (!NAME_RE.test(name)) throw new Error(`invalid vault entry name: ${name}`);
    return join(this.dir, `${name}.sealed`);
  }

  private tryKey(): Uint8Array | null {
    try {
      return this.keyProvider();
    } catch {
      return null; // no master key set
    }
  }

  /** True when a master key is present (the store can seal). */
  isUnlocked(): boolean {
    return this.tryKey() !== null;
  }

  /** Seal a value under `name`. Throws when no master key is set. */
  set(name: string, plaintext: string): void {
    const key = this.keyProvider(); // throws (clear error) when unset
    mkdirSync(this.dir, { recursive: true });
    const file = this.pathFor(name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, sealWithKey(key, plaintext));
    renameSync(tmp, file);
  }

  /** The plaintext for `name`, or `null` when absent / no key / wrong key. */
  get(name: string): string | null {
    const key = this.tryKey();
    if (!key) return null;
    const file = this.pathFor(name);
    if (!existsSync(file)) return null;
    try {
      return unsealWithKey(key, readFileSync(file, "utf8"));
    } catch {
      return null; // wrong key / tampered — locked, not a crash.
    }
  }

  has(name: string): boolean {
    return existsSync(this.pathFor(name));
  }

  delete(name: string): void {
    const file = this.pathFor(name);
    if (existsSync(file)) rmSync(file);
  }

  clear(): void {
    for (const name of this.names()) this.delete(name);
  }

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".sealed"))
      .map((f) => f.slice(0, -".sealed".length));
  }

  private fingerprint(key: Uint8Array): string {
    return createHash("sha256").update(Buffer.from(key)).digest("hex").slice(0, 8);
  }

  status(): SealedStoreStatus {
    const key = this.tryKey();
    const names = this.names();
    if (!key) {
      return { mode: "empty", unlocked: false, fingerprint: null, sealedCount: names.length, names };
    }
    const locked = names.some((n) => this.get(n) === null && this.has(n));
    return {
      mode: locked ? "locked" : "sealed",
      unlocked: true,
      fingerprint: this.fingerprint(key),
      sealedCount: names.length,
      names,
    };
  }

  /**
   * Rotate the master key by RE-SEALING every entry (never a raw key swap —
   * `automaton/02` §4). Plan first: unseal every entry with `oldKey` and abort
   * before any write if any fails; then re-seal all under `newKey` atomically per
   * file. Returns the number of entries rotated. The caller persists the new key
   * (env/disk) AFTER this returns and flips the in-memory key last.
   */
  rotateMasterKey(oldKey: Uint8Array, newKey: Uint8Array): number {
    const names = this.names();
    // PLAN — unwrap all with the old key; a single failure aborts before any write.
    const plan = names.map((name) => ({
      name,
      plaintext: unsealWithKey(oldKey, readFileSync(this.pathFor(name), "utf8")),
    }));
    // APPLY — re-seal each under the new key (atomic temp→rename per file).
    for (const { name, plaintext } of plan) {
      const file = this.pathFor(name);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, sealWithKey(newKey, plaintext));
      renameSync(tmp, file);
    }
    return plan.length;
  }
}

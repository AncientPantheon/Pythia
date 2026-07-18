import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A sealed store for BEARER credentials Pythia must USE (chiefly the hub M2M HMAC
 * secret). Each value is encrypted at rest with **AES-256-GCM** under a key
 * derived (`scrypt`) from a master key + a per-blob random salt, so the data
 * volume alone never yields the plaintext — you also need the master key, which
 * lives in the deploy env (`PYTHIA_MASTER_KEY`), off the volume.
 *
 * Keyless: this is at-rest encryption of bearer creds — it never signs a
 * blockchain transaction and never holds a chain key (same posture as the HMAC
 * use in `hub/serviceClient.ts`). `node:crypto` symbols here are not the banned
 * broadcast/keygen surface.
 *
 * Locked semantics: with no master key the vault is "empty" (dev fallback — the
 * caller keeps today's plaintext path); with a key that cannot decrypt existing
 * blobs it is "locked" and reads return `null` so the feed falls back to env/off
 * rather than crashing.
 */

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SCRYPT_SALT_LEN = 16;

/** One sealed value on disk. Nothing here reveals the plaintext or the key. */
interface SealedBlob {
  v: 1;
  salt: string; // base64 scrypt salt
  iv: string; // base64 GCM iv
  ct: string; // base64 ciphertext
  tag: string; // base64 GCM auth tag
}

export type VaultMode = "sealed" | "locked" | "empty";

export interface VaultStatus {
  /** `empty` = no master key (dev plaintext fallback); `sealed` = key present and
   * healthy; `locked` = key present but a stored blob won't decrypt (key mismatch). */
  mode: VaultMode;
  /** True when a master key is present (able to seal), regardless of blob health. */
  unlocked: boolean;
  /** First 8 hex of `sha256(masterKey)` — identifies WHICH key is loaded without
   * revealing it — or `null` when no key is set. */
  fingerprint: string | null;
  sealedCount: number;
  names: string[];
}

export interface SealedVaultOpts {
  filePath: string;
  /** The master key from the deploy env (`PYTHIA_MASTER_KEY`). Absent/empty ⇒ the
   * vault is locked and cannot seal (dev fallback). */
  masterKey?: string;
}

export class SealedVault {
  private readonly filePath: string;
  /** Not `readonly`: `rotateMasterKey` adopts the new key so the running instance
   * stays coherent with the blobs it just re-sealed. */
  private masterKey: string | null;
  private blobs: Record<string, SealedBlob> = {};

  constructor(opts: SealedVaultOpts) {
    this.filePath = opts.filePath;
    const mk = opts.masterKey?.trim();
    this.masterKey = mk ? mk : null;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        this.blobs = parsed as Record<string, SealedBlob>;
      }
    } catch {
      // Absent/invalid → empty; first seal materialises it.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.blobs, null, 2));
    renameSync(tmp, this.filePath);
  }

  private deriveKey(masterKey: string, salt: Buffer): Buffer {
    return scryptSync(masterKey, salt, KEY_LEN);
  }

  private seal(masterKey: string, plaintext: string): SealedBlob {
    const salt = randomBytes(SCRYPT_SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = this.deriveKey(masterKey, salt);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: tag.toString("base64"),
    };
  }

  /** Unseal a blob with the given key, or `null` if the key can't decrypt it. */
  private unseal(masterKey: string, blob: SealedBlob): string | null {
    try {
      const key = this.deriveKey(masterKey, Buffer.from(blob.salt, "base64"));
      const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, "base64"));
      decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(blob.ct, "base64")),
        decipher.final(),
      ]);
      return pt.toString("utf8");
    } catch {
      return null; // wrong key / tampered blob — locked, not a crash.
    }
  }

  /** True when a master key is present (the vault can seal). */
  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  private fingerprint(): string | null {
    if (this.masterKey === null) return null;
    return createHash("sha256").update(this.masterKey).digest("hex").slice(0, 8);
  }

  /** Seal a value under `name`. Throws when the vault is locked (no master key) —
   * the caller must not silently persist plaintext. */
  set(name: string, plaintext: string): void {
    if (this.masterKey === null) {
      throw new Error("SealedVault is locked (no master key) — cannot seal");
    }
    this.blobs[name] = this.seal(this.masterKey, plaintext);
    this.persist();
  }

  /** The plaintext for `name`, or `null` when absent, locked (no key), or the key
   * can't decrypt it (wrong key). */
  get(name: string): string | null {
    const blob = this.blobs[name];
    if (!blob || this.masterKey === null) return null;
    return this.unseal(this.masterKey, blob);
  }

  private has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.blobs, name);
  }

  delete(name: string): void {
    if (this.has(name)) {
      delete this.blobs[name];
      this.persist();
    }
  }

  /** Delete every sealed blob (decommission). */
  clear(): void {
    this.blobs = {};
    this.persist();
  }

  /**
   * Re-encrypt every blob from `oldKey` to `newKey`. Ops-only (not a browser
   * action). Throws BEFORE mutating anything if any blob fails to decrypt under
   * `oldKey` (wrong old key) so a rotation never silently drops creds. On success
   * the instance adopts `newKey`, so this same object keeps reading its blobs.
   */
  rotateMasterKey(oldKey: string, newKey: string): void {
    const next: Record<string, SealedBlob> = {};
    for (const [name, blob] of Object.entries(this.blobs)) {
      const pt = this.unseal(oldKey, blob);
      if (pt === null) {
        throw new Error(`rotateMasterKey: "${name}" did not decrypt under the old key`);
      }
      next[name] = this.seal(newKey, pt);
    }
    this.blobs = next;
    this.masterKey = newKey;
    this.persist();
  }

  status(): VaultStatus {
    const names = Object.keys(this.blobs);
    let mode: VaultMode;
    if (this.masterKey === null) {
      mode = "empty";
    } else if (names.some((n) => this.unseal(this.masterKey as string, this.blobs[n]) === null)) {
      mode = "locked"; // key present but a blob won't decrypt — mismatch.
    } else {
      mode = "sealed";
    }
    return {
      mode,
      unlocked: this.isUnlocked(),
      fingerprint: this.fingerprint(),
      sealedCount: names.length,
      names,
    };
  }
}

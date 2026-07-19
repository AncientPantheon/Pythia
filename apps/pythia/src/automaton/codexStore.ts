import { randomBytes } from "node:crypto";
import type { SealedStore } from "../codex/sealedStore.js";

/**
 * Server-custody Codex store — the automaton half. The Codex snapshot blob (with its
 * per-entry secrets already encrypted under the codex password) and the machine-minted
 * **codex password** are each sealed as ordinary entries in Pythia's ONE canonical vault
 * (`automaton/02` two-layer model). Server-held auto-unlock: no operator prompt.
 *
 * This is KEYED custody (it holds the material that decrypts to signing keys), hence its
 * home under `src/automaton/` — exempt from the keyless scanner, unreachable from the
 * client request path.
 */

const PASSWORD_ENTRY = "codexPassword";
const BACKUP_ENTRY = "codexBackup";

export class CodexStore {
  constructor(private readonly vault: SealedStore) {}

  /** The machine codex password (32-byte base64), minted + sealed on first use and
   * idempotent thereafter — the inner layer that decrypts the snapshot's entries. */
  getOrCreateCodexPassword(): string {
    const existing = this.vault.get(PASSWORD_ENTRY);
    if (existing) return existing;
    const pw = randomBytes(32).toString("base64");
    this.vault.set(PASSWORD_ENTRY, pw);
    return pw;
  }

  /** The sealed Codex snapshot blob, or `null` before the first save / when locked. */
  loadBackup(): string | null {
    return this.vault.get(BACKUP_ENTRY);
  }

  /** Seal a Codex snapshot blob (provisioning the machine password first). */
  saveBackup(blob: string): void {
    this.getOrCreateCodexPassword();
    this.vault.set(BACKUP_ENTRY, blob);
  }

  /** Decommission: remove the snapshot and the machine password. */
  clearCodex(): void {
    this.vault.delete(BACKUP_ENTRY);
    this.vault.delete(PASSWORD_ENTRY);
  }

  /** Whether a Codex snapshot has been stored. */
  initialized(): boolean {
    return this.vault.get(BACKUP_ENTRY) !== null;
  }
}

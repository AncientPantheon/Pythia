import type { ApolloSigner } from "@ancientpantheon/pythia-client";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import type { CodexStore } from "./codexStore.js";

/**
 * Codex-backed Apollo signer — Pythia's own unattended signing source
 * (`docs/work/self-connector-codex-signing/design.md`). Mirrors
 * `khronoton/keyResolver.ts`'s exact pattern: re-read the sealed Codex
 * snapshot + machine password fresh on every call (fire-time, not
 * hot-path, never cached — a Codex edit is picked up next call and
 * plaintext key material never outlives the call), delegate to Codex's
 * own `autoSignApolloChallenge` (`@ancientpantheon/codex/ouronet`, v0.7.0),
 * throw a clear named error rather than fail silently.
 */

interface SnapshotLike {
  ouroAccounts?: IOuroAccount[];
}

function loadSnapshot(codex: CodexStore): SnapshotLike {
  const backup = codex.loadBackup();
  if (backup === null) {
    throw new Error(
      "codex apollo signer: Pythia's operator codex is not initialized — generate and " +
        "activate her Apollo identity under /admin (Codex) first.",
    );
  }
  return JSON.parse(backup) as SnapshotLike;
}

/** `loadSnapshot`, but resolves to `null` instead of throwing when the codex
 * isn't initialized yet — the one call site (`codexHoldsAccount`) that wants
 * "doesn't hold it yet" rather than a thrown error for that case. Keeping
 * exactly one function that turns `codex.loadBackup()` into a parsed
 * snapshot (this one delegates to `loadSnapshot`, never re-parses itself)
 * means a future change to the parse/guard logic can't silently drift
 * between two independent copies. */
function tryLoadSnapshot(codex: CodexStore): SnapshotLike | null {
  try {
    return loadSnapshot(codex);
  } catch {
    return null;
  }
}

const ouros = (s: SnapshotLike): IOuroAccount[] => (Array.isArray(s.ouroAccounts) ? s.ouroAccounts : []);

/** Whether `codex`'s current snapshot holds an `IOuroAccount` whose
 * `.address` (the actual `₱.…`/`Π.…` account string — NOT `.publicKey`,
 * Codex's own separate "Codex-local public key") matches `apolloAccount`.
 * A query, not an action: an uninitialized codex just means "doesn't hold
 * it yet," so this returns `false` rather than throwing. */
export function codexHoldsAccount(codex: CodexStore, apolloAccount: string): boolean {
  const snapshot = tryLoadSnapshot(codex);
  if (!snapshot) return false;
  return ouros(snapshot).some((account) => account.address === apolloAccount);
}

/** An `ApolloSigner` scoped to `apolloAccount`, backed by `codex`'s
 * `autoSignApolloChallenge`. Every `sign()` call re-reads the codex
 * snapshot + password fresh — see the module doc comment. */
export function createCodexApolloSigner(codex: CodexStore, apolloAccount: string): ApolloSigner {
  return {
    sign: async ({ apolloAccount: signedAccount, nonce, rp }) => {
      if (signedAccount !== apolloAccount) {
        throw new Error(
          `codex apollo signer: asked to sign for ${signedAccount} but this signer is scoped to ${apolloAccount}`,
        );
      }
      const snapshot = loadSnapshot(codex);
      const codexPassword = codex.getOrCreateCodexPassword();
      const { autoSignApolloChallenge } = await import("@ancientpantheon/codex/ouronet");
      const { sig } = await autoSignApolloChallenge(snapshot, codexPassword, apolloAccount, nonce, rp);
      return { signature: sig };
    },
  };
}

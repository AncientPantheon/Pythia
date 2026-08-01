import { splitDualLinkKey, type ApolloSigner } from "@ancientpantheon/pythia-client";
import type { SealedStore } from "../codex/sealedStore.js";
import { buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";

/**
 * Pythia's own dual-Apollo identity — the same "two independent, unrelated
 * Apollo accounts, one Standard (₱.) + one Smart (Π.)" pair shape every other
 * connector consumer uses (`docs/work/pythia-self-consumer/design.md` §Approach
 * 1). Deliberately NOT `Apollo.generateRandom()`'s two address forms off one
 * call — that's one keypair's two encodings, not a pair.
 */
export interface SelfApolloAccounts {
  standardAccount: string | null;
  smartAccount: string | null;
}

const ENTRY_NAMES = {
  standard: "self-apollo-standard",
  smart: "self-apollo-smart",
} as const;

/** Holds the pasted dual-link-key as plain text — a public composite account
 * string, NOT the `SealedHalf` JSON shape the two account halves above use
 * (there's no private key material in it). Sealed anyway since it already
 * lives in the same vault and durability-across-restart matters. */
const DUAL_LINK_KEY_ENTRY = "self-dual-link-key";

type Half = keyof typeof ENTRY_NAMES;

interface SealedHalf {
  account: string;
  priv: string;
  publ: string;
}

function parseHalf(store: SealedStore, entryName: string): SealedHalf | null {
  const raw = store.get(entryName);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SealedHalf;
  } catch {
    return null;
  }
}

/**
 * Sealed-vault-backed Standard + Smart Apollo identity, generated on demand
 * and read back for signing. Mirrors `apolloVerify.ts`'s dynamic-import
 * pattern for `@ouronet/dalos-crypto/registry` (ESM-only; a load failure
 * during signing must surface as a thrown error, not silently sign garbage).
 */
export class SelfApolloVault {
  /** The in-flight `ensureGenerated()` call, if any — memoized so concurrent
   * callers (e.g. a double-click or two admin tabs both hitting `POST
   * /admin/self-connector/generate`) await the SAME generation instead of
   * each independently racing to `store.set()`. Without this, the
   * check-then-act gap between `store.has()` and `store.set()` (straddling a
   * real `await import(...)` yield point) let two concurrent calls both
   * observe "not yet generated," each mint a DIFFERENT random keypair, and
   * the second `set()` silently clobber the first — orphaning whichever
   * account string the losing response displayed (CONFIRMED HIGH in review:
   * the admin manually pays real on-chain STOA to register that string, so a
   * lost keypair is not just a bug, it's stranded funds). Mirrors
   * `PythiaConnector.refreshing`'s identical in-flight-dedup pattern
   * (`packages/pythia-client/src/connector.ts`). Cleared in a `finally` so a
   * failed generation doesn't wedge every later call behind a rejected
   * promise forever. */
  private generating: Promise<SelfApolloAccounts> | null = null;

  constructor(private readonly store: SealedStore) {}

  /**
   * Generates whichever half(s) are missing (each independently, via its own
   * `Apollo.generateRandom()` call — never one call's two address forms) and
   * seals them; leaves an already-present half completely untouched. Safe to
   * call repeatedly — idempotent, AND safe to call concurrently (see
   * `generating` above) — the whole point of "idempotent" only holds if
   * concurrent calls can't each independently mutate the store.
   */
  async ensureGenerated(): Promise<SelfApolloAccounts> {
    if (this.generating) return this.generating;
    const run = this.doEnsureGenerated().finally(() => {
      this.generating = null;
    });
    this.generating = run;
    return run;
  }

  private async doEnsureGenerated(): Promise<SelfApolloAccounts> {
    for (const half of Object.keys(ENTRY_NAMES) as Half[]) {
      const entryName = ENTRY_NAMES[half];
      if (this.store.has(entryName)) continue;
      const registry = await import("@ouronet/dalos-crypto/registry");
      const full = registry.Apollo.generateRandom();
      const account = half === "standard" ? full.standardAddress : full.smartAddress;
      const sealed: SealedHalf = {
        account,
        priv: full.keyPair.priv,
        publ: full.keyPair.publ,
      };
      this.store.set(entryName, JSON.stringify(sealed));
    }
    return { standardAccount: this.standardAccount(), smartAccount: this.smartAccount() };
  }

  /** The Standard (₱.) account string, or `null` if not yet generated / the
   * store can't decrypt (locked/no key). */
  standardAccount(): string | null {
    return parseHalf(this.store, ENTRY_NAMES.standard)?.account ?? null;
  }

  /** The Smart (Π.) account string, or `null` if not yet generated / the
   * store can't decrypt (locked/no key). */
  smartAccount(): string | null {
    return parseHalf(this.store, ENTRY_NAMES.smart)?.account ?? null;
  }

  /** The currently-set dual-link-key (the public composite account string
   * pasted via `setDualLinkKey`), or `null` if none has been set yet. */
  dualLinkKey(): string | null {
    return this.store.get(DUAL_LINK_KEY_ENTRY) ?? null;
  }

  /**
   * Validates `key` via `splitDualLinkKey` (throws
   * `PythiaConnectorValidationError` unchanged for a malformed key), then
   * confirms BOTH resulting halves exactly match this vault's own held
   * `standardAccount()`/`smartAccount()` (throws a clear `Error` naming the
   * mismatched half otherwise) — this is the SELF panel, so pasting a key for
   * any pair other than Pythia's own is always a mistake, and this should
   * reject immediately at paste time rather than surface later as a
   * confusing mid-tick `onError`. Only on a full match is the key sealed.
   */
  setDualLinkKey(key: string): void {
    const { standardApollo, smartApollo } = splitDualLinkKey(key);
    if (standardApollo !== this.standardAccount()) {
      throw new Error(
        `self-apollo: pasted dual-link-key's standard half (${standardApollo}) does not match this vault's own standard account (${this.standardAccount()})`,
      );
    }
    if (smartApollo !== this.smartAccount()) {
      throw new Error(
        `self-apollo: pasted dual-link-key's smart half (${smartApollo}) does not match this vault's own smart account (${this.smartAccount()})`,
      );
    }
    this.store.set(DUAL_LINK_KEY_ENTRY, key);
  }

  /**
   * An `ApolloSigner` (`@ancientpantheon/pythia-client`) for `which` half.
   * Reads the sealed keypair back per call, builds the canonical challenge
   * message via `buildChallengeMessage`, and signs via `Apollo.sign` — the
   * same dynamic-import pattern as `apolloVerify.ts`. Throws if `which`
   * hasn't been generated yet, rather than signing garbage.
   */
  createSigner(which: Half): ApolloSigner {
    return {
      sign: async ({ apolloAccount, nonce, rp }) => {
        const half = parseHalf(this.store, ENTRY_NAMES[which]);
        if (!half) {
          throw new Error(`self-apollo: the "${which}" half has not been generated yet`);
        }
        // Defense in depth: this signer must only ever sign a challenge for
        // the account it actually holds the key for — a caller passing a
        // mismatched `apolloAccount` (e.g. a future connector-composition bug
        // wiring this signer to the wrong PythiaConnector) gets a clear
        // rejection here, not a signature silently computed against the
        // WRONG account's challenge message (which would just fail to verify
        // on-chain, but only after the fact, with no clear cause).
        if (apolloAccount !== half.account) {
          throw new Error(
            `self-apollo: asked to sign for ${apolloAccount} but the "${which}" half holds ${half.account}`,
          );
        }
        const message = buildChallengeMessage({ apollo: apolloAccount, nonce, rp });
        const registry = await import("@ouronet/dalos-crypto/registry");
        if (typeof registry.Apollo.sign !== "function") {
          throw new Error("self-apollo: the Apollo primitive does not support signing");
        }
        const signature = registry.Apollo.sign(
          { priv: half.priv, publ: half.publ },
          message,
        );
        return { signature };
      },
    };
  }
}

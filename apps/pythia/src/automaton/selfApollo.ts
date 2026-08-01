import { splitDualLinkKey, type ApolloSigner } from "@ancientpantheon/pythia-client";
import type { SealedStore } from "../codex/sealedStore.js";
import type { CodexStore } from "./codexStore.js";
import { codexHoldsAccount, createCodexApolloSigner } from "./codexApolloSigner.js";

/** Holds the pasted dual-link-key as plain text — a public composite account
 * string (no private key material in it, unlike the old per-half sealed
 * entries this class used to hold). Sealed anyway since it already lives in
 * the same vault and durability-across-restart matters. */
const DUAL_LINK_KEY_ENTRY = "self-dual-link-key";

type Half = "standard" | "smart";

/**
 * Pythia's own dual-Apollo identity (`docs/work/self-connector-codex-signing/
 * design.md`) — held entirely by her own Codex, never generated or stored
 * here. Generation and on-chain activation happen exclusively via Codex's own
 * admin tab (proper seed-word/confirmation UX); this vault's only remaining
 * job is to hold the OPERATOR-CONFIRMED `dualLinkKey` (the pasted composite
 * account string binding her Standard + Smart accounts together, validated
 * against Codex's own `ouroAccounts` snapshot at paste time — see
 * `setDualLinkKey`) and hand back `ApolloSigner`s that delegate unattended
 * signing to Codex's own `autoSignApolloChallenge` (`codexApolloSigner.ts`).
 */
export class SelfApolloVault {
  constructor(
    private readonly store: SealedStore,
    private readonly codex: CodexStore,
  ) {}

  /** The Standard (₱.) half of the currently-set `dualLinkKey()`, or `null`
   * if none has been set yet. Derived, never independently persisted — see
   * the class doc comment. */
  standardAccount(): string | null {
    const key = this.dualLinkKey();
    return key ? splitDualLinkKey(key).standardApollo : null;
  }

  /** The Smart (Π.) half of the currently-set `dualLinkKey()`, or `null` if
   * none has been set yet. Derived, never independently persisted — see the
   * class doc comment. */
  smartAccount(): string | null {
    const key = this.dualLinkKey();
    return key ? splitDualLinkKey(key).smartApollo : null;
  }

  /** The currently-set dual-link-key (the public composite account string
   * pasted via `setDualLinkKey`), or `null` if none has been set yet. */
  dualLinkKey(): string | null {
    return this.store.get(DUAL_LINK_KEY_ENTRY) ?? null;
  }

  /**
   * Validates `key` via `splitDualLinkKey` (throws
   * `PythiaConnectorValidationError` unchanged for a malformed key), then
   * confirms Pythia's own Codex actually holds BOTH resulting halves (via
   * `codexHoldsAccount`) — a strictly MORE meaningful check than the old
   * "matches this vault's own generated accounts" (no longer meaningful,
   * since nothing is generated here anymore): it confirms Pythia can
   * actually sign for both halves, not just that a string matches another
   * string. Throws a clear `Error` naming the specific missing half
   * otherwise (standard checked first, then smart). Only when BOTH are held
   * is the key sealed.
   */
  setDualLinkKey(key: string): void {
    const { standardApollo, smartApollo } = splitDualLinkKey(key);
    if (!codexHoldsAccount(this.codex, standardApollo)) {
      throw new Error(
        `self-apollo: the standard half (${standardApollo}) of this dual-link-key is not held by Pythia's own Codex — generate and activate it there first`,
      );
    }
    if (!codexHoldsAccount(this.codex, smartApollo)) {
      throw new Error(
        `self-apollo: the smart half (${smartApollo}) of this dual-link-key is not held by Pythia's own Codex — generate and activate it there first`,
      );
    }
    this.store.set(DUAL_LINK_KEY_ENTRY, key);
  }

  /**
   * An `ApolloSigner` (`@ancientpantheon/pythia-client`) for `which` half — a
   * thin wrapper delegating to `createCodexApolloSigner` (`codexApolloSigner.
   * ts`), Codex's own `autoSignApolloChallenge`, unattended. The
   * not-yet-linked check happens INSIDE the returned signer's `sign()`, not
   * here at `createSigner` call time, since `SelfConnectorLoop` constructs
   * its signers once and may call `.sign` before or after a key is later set.
   */
  createSigner(which: Half): ApolloSigner {
    return {
      sign: async (input) => {
        const account = which === "standard" ? this.standardAccount() : this.smartAccount();
        if (!account) {
          throw new Error(`self-apollo: no dual-link-key set — the "${which}" half is unknown`);
        }
        return createCodexApolloSigner(this.codex, account).sign(input);
      },
    };
  }
}

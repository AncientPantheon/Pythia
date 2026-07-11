/**
 * The canonical message for GENERIC Apollo-ownership verification — the EXACT
 * text the verifier (any Codex / OuronetUI / Mnemosyne) signs with the account's
 * Apollo key and the relying party verifies with `Apollo.verify`. It MUST be
 * byte-for-byte identical on both sides; any drift breaks every verification.
 *
 * This is NOT Pythia-specific: it's an "Apollo ownership proof" scoped to a
 * relying party (`rp`), so any consumer (Pythia today, others later) reuses the
 * SAME verifier route — each consumer just passes its own `rp`, which
 * domain-separates its proofs from every other RP's. Mirror this format verbatim
 * in the verifier's `/apollo-verify` sign route.
 *
 * Pure: no I/O, no `@stoachain/*`, no `Date.now()` — the nonce is an input.
 */

/** Pythia's stable relying-party identifier (the `rp` it presents to verifiers).
 * Constant across deployments — cross-deployment replay is already prevented by
 * the per-server single-use nonce. */
export const RP = "pythia.ancientholdings.eu";

/** Challenge lifetime — a signature is only accepted within this window. */
export const CHALLENGE_TTL_SECONDS = 15 * 60;

export interface ChallengeMessageParts {
  /** The Apollo account being proven (`₱.…` standard or `Π.…` smart). */
  apollo: string;
  /** Server-issued random nonce (hex) — single-use + TTL'd server-side. */
  nonce: string;
  /** Relying-party id (audience); defaults to {@link RP}. */
  rp?: string;
}

/**
 * Build the canonical, multi-line UTF-8 message. Both the verifier's Apollo
 * `sign` and the relying party's `Apollo.verify` operate on exactly this string.
 * Deliberately minimal — the apollo account + nonce + the relying party. Freshness
 * is enforced server-side via the stored challenge, not encoded in the message.
 */
export function buildChallengeMessage(p: ChallengeMessageParts): string {
  const rp = p.rp ?? RP;
  return [
    "Apollo ownership proof",
    `apollo: ${p.apollo}`,
    `nonce: ${p.nonce}`,
    `rp: ${rp}`,
  ].join("\n");
}

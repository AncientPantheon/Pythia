/**
 * The canonical challenge message for Apollo-half ownership verification — the
 * EXACT text the verifier (OuronetUI / Codex / Mnemosyne) signs with the half's
 * Apollo key and Pythia verifies with `Apollo.verify`. It MUST be byte-for-byte
 * identical on both sides; any drift breaks every verification. Mirror this
 * verbatim in the verifier's Apollo sign route.
 *
 * Pure: no I/O, no `@stoachain/*`, no `Date.now()` — the nonce is an input.
 */

/** Domain-separation tag baked into the signed message (distinct from the hub's
 * `ancientholdings.eu` Ouronet-account tag, so an Ouronet-verification signature
 * can never be replayed as a Pythia Apollo proof). */
export const VERIFY_DOMAIN = "pythia.ancientholdings.eu";

/** Challenge lifetime — a signature is only accepted within this window. */
export const CHALLENGE_TTL_SECONDS = 15 * 60;

export interface ChallengeMessageParts {
  /** The Apollo half being proven (`₱.…` standard or `Π.…` smart). */
  apollo: string;
  /** Server-issued random nonce (hex) — single-use + TTL'd server-side. */
  nonce: string;
  /** Domain tag; defaults to {@link VERIFY_DOMAIN}. */
  domain?: string;
}

/**
 * Build the canonical, multi-line UTF-8 message. Both the verifier's Apollo
 * `sign` and Pythia's `Apollo.verify` operate on exactly this string. Deliberately
 * minimal — only what the verifier gets from the deep-link (the apollo account +
 * nonce) plus the domain tag. Freshness/expiry is enforced server-side via the
 * stored challenge, not encoded in the message.
 */
export function buildChallengeMessage(p: ChallengeMessageParts): string {
  const domain = p.domain ?? VERIFY_DOMAIN;
  return [
    "Pythia · Apollo key ownership",
    `apollo: ${p.apollo}`,
    `nonce: ${p.nonce}`,
    `domain: ${domain}`,
  ].join("\n");
}

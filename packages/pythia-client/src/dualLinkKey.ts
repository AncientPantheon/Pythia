import { PythiaConnectorValidationError } from "./connectorErrors.js";

/**
 * A validating `splitDualLinkKey` for consumers of `@ancientpantheon/pythia-client` —
 * a port of the private, unvalidated `splitDualLinkKey` in
 * `apps/pythia/src/connectors/auth/dualLinkCache.ts` (that version trusts its
 * caller to have already length-checked the key). This SDK version is fed
 * directly by pasted user input in a UI form, so it validates everything
 * itself and throws a message naming the SPECIFIC problem rather than
 * silently slicing a malformed string.
 */

/** The length (chars) of one Apollo account half (standard OR smart) within a
 * composite `dual-link-key`. Mirrors `apps/pythia`'s `APOLLO_ACCOUNT_LEN` —
 * `packages/pythia-client` can't import from `apps/pythia` (separate
 * package), so this is a small, deliberate duplication of the constant. */
export const APOLLO_ACCOUNT_LEN = 162;

/** The separator a composite `dual-link-key` is built with
 * (`standard || DUAL_LINK_BAR || smart`). Must stay byte-identical to the
 * on-chain `CT_Bar` value (see `dualLinkCache.ts`'s `PYTHIA_DUAL_LINK_BAR`). */
export const DUAL_LINK_BAR = "|";

/** ₱ = U+20B1 (Standard Apollo), Π = U+03A0 (Smart Apollo) — mirrors
 * `apps/pythia/src/routes/connectorVerify.ts`'s `isStandardApollo`/
 * `isSmartApollo` classification codepoints (same duplication reasoning as
 * `APOLLO_ACCOUNT_LEN` above: no cross-package import is possible). */
const STANDARD_APOLLO_CODEPOINT = 0x20b1;
const SMART_APOLLO_CODEPOINT = 0x03a0;

const DUAL_LINK_KEY_LEN = APOLLO_ACCOUNT_LEN * 2 + DUAL_LINK_BAR.length;

export interface DualLinkHalves {
  standardApollo: string;
  smartApollo: string;
}

/**
 * Split and validate a composite `dual-link-key` (`standard || "|" || smart`,
 * 325 chars) into its two Apollo-account halves. Throws
 * {@link PythiaConnectorValidationError} — with a message naming the specific
 * problem, so a UI form can show something genuinely useful — on any
 * malformed shape: wrong total length, a missing/misplaced separator, or a
 * half that doesn't start with the expected ₱/Π codepoint.
 */
export function splitDualLinkKey(dualLinkKey: string): DualLinkHalves {
  if (dualLinkKey.length !== DUAL_LINK_KEY_LEN) {
    throw new PythiaConnectorValidationError(
      `invalid dual-link-key: expected ${DUAL_LINK_KEY_LEN} characters, got ${dualLinkKey.length}`,
    );
  }
  if (dualLinkKey[APOLLO_ACCOUNT_LEN] !== DUAL_LINK_BAR) {
    throw new PythiaConnectorValidationError(
      `invalid dual-link-key: expected "${DUAL_LINK_BAR}" at position ${APOLLO_ACCOUNT_LEN}`,
    );
  }
  const standardApollo = dualLinkKey.slice(0, APOLLO_ACCOUNT_LEN);
  const smartApollo = dualLinkKey.slice(APOLLO_ACCOUNT_LEN + DUAL_LINK_BAR.length);
  if (standardApollo.codePointAt(0) !== STANDARD_APOLLO_CODEPOINT) {
    throw new PythiaConnectorValidationError(
      "invalid dual-link-key: the standard half must start with ₱",
    );
  }
  if (smartApollo.codePointAt(0) !== SMART_APOLLO_CODEPOINT) {
    throw new PythiaConnectorValidationError(
      "invalid dual-link-key: the smart half must start with Π",
    );
  }
  return { standardApollo, smartApollo };
}

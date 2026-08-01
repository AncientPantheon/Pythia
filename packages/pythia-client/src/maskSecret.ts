/**
 * Mask a secret for display: `first7...last7`. Used anywhere a secret's
 * existence/shape needs confirming (e.g. an admin panel) without ever
 * rendering the raw value — mirrors the existing `secretMask()` convention
 * used for the hub HMAC secret elsewhere in this codebase.
 *
 * Any string shorter than 14 characters (`slice(0, 7)` and `slice(-7)` would
 * overlap below that length) is returned unchanged rather than producing
 * overlapping/negative-slice garbage.
 */
export function maskSecret(secret: string): string {
  if (secret.length < 14) {
    return secret;
  }
  return `${secret.slice(0, 7)}...${secret.slice(-7)}`;
}

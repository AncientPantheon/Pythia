import sodium from "libsodium-wrappers";

/**
 * The canonical Pantheonic at-rest seal (`automaton/02`, verified identical on the
 * AncientHub and Mnemosyne): libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305),
 * a random 24-byte nonce prepended to the ciphertext, the whole thing base64. The
 * 32-byte master key is read per-operation from `PYTHIA_MASTER_KEY` (base64) and
 * never cached in a module-level variable.
 *
 * Keyless: this is at-rest sealing of Pythia's own operator/codex secrets — it never
 * signs a blockchain transaction. Signing is the Codex resolver's job (Topic 2).
 */

/** Await once before any sync `*WithKey` call (libsodium initialises asynchronously). */
export async function ensureSodiumReady(): Promise<void> {
  await sodium.ready;
}

/** Parse a base64 master key into exactly 32 bytes, or throw a clear error. */
export function parseMasterKey(base64: string | undefined): Uint8Array {
  if (!base64) {
    throw new Error(
      'PYTHIA_MASTER_KEY must be set (32 bytes, base64-encoded). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(`PYTHIA_MASTER_KEY must decode to exactly 32 bytes (got ${key.length})`);
  }
  return new Uint8Array(key);
}

/** The current master key from the environment. */
export function readMasterKey(): Uint8Array {
  return parseMasterKey(process.env.PYTHIA_MASTER_KEY);
}

/** Seal a value under an explicit key (sync; requires {@link ensureSodiumReady}). */
export function sealWithKey(key: Uint8Array, plaintext: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);
  return Buffer.from(combined).toString("base64");
}

/** Unseal a value with an explicit key (sync). Throws on a wrong key / tampered box. */
export function unsealWithKey(key: Uint8Array, sealed: string): string {
  const combined = new Uint8Array(Buffer.from(sealed, "base64"));
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return sodium.to_string(plaintext);
}

/** Seal under the env master key (awaits libsodium). */
export async function seal(plaintext: string): Promise<string> {
  await sodium.ready;
  return sealWithKey(readMasterKey(), plaintext);
}

/** Unseal under the env master key (awaits libsodium). */
export async function unseal(sealed: string): Promise<string> {
  await sodium.ready;
  return unsealWithKey(readMasterKey(), sealed);
}

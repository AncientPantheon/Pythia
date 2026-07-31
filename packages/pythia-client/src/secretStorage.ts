/**
 * The injection point for a consumer's OWN secret persistence (e.g. sealing
 * the secret in the consumer's own vault) — mirrors `ApolloSigner`'s
 * bring-your-own-implementation shape. `PythiaConnector` (a later addition)
 * is the sole decider of staleness/expiry; this store holds and returns
 * whatever entry it was given verbatim, with no TTL logic of its own.
 */

/** A cached connector secret plus the epoch-ms timestamp it expires at. */
export interface SecretStorage {
  load(): Promise<{ secret: string; expiresAt: number } | null>;
  save(entry: { secret: string; expiresAt: number }): Promise<void>;
  clear(): Promise<void>;
}

/** Trivial default `SecretStorage` backed by a single in-process field — no
 * persistence across restarts. Lets the SDK be used standalone without
 * forcing every consumer to write a storage adapter before their first test. */
export class InMemorySecretStorage implements SecretStorage {
  private entry: { secret: string; expiresAt: number } | null = null;

  async load(): Promise<{ secret: string; expiresAt: number } | null> {
    return this.entry;
  }

  async save(entry: { secret: string; expiresAt: number }): Promise<void> {
    this.entry = entry;
  }

  async clear(): Promise<void> {
    this.entry = null;
  }
}

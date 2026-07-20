# Ops — the sealed-store master key (`PYTHIA_MASTER_KEY`)

Pythia seals the credentials she must *use* (the hub M2M HMAC secret) AND her own
operator **Codex** (the signing-key backup + its codex password) at rest under
**`PYTHIA_MASTER_KEY`**, using the canonical Pantheon scheme — libsodium
`crypto_secretbox` (XSalsa20-Poly1305), identical to the hub and Mnemosyne. The key is a
**deploy-env secret**: it lives in the container/systemd env, **off the `/data`
volume**, so a leaked volume alone never yields the secrets or the codex.

Related: [`docs/HANDOFF-pythia-side-buildout.md`](HANDOFF-pythia-side-buildout.md) (the
hub HMAC secret this seals), `apps/pythia/src/codex/vault.ts` (the seal primitive),
`apps/pythia/src/codex/sealedStore.ts` (the directory store).

## What the key is
- **Exactly 32 bytes, base64-encoded** — `base64_decode(PYTHIA_MASTER_KEY)` must be 32
  bytes or the store stays locked at boot. This is the raw secretbox key (not a
  passphrase stretched with a KDF); treat it like a root password.
- The store is a **directory** of `<name>.sealed` files on the `/data` volume, each
  holding `nonce ‖ ciphertext` — never the key, never the plaintext. Entries today:
  the hub HMAC secret, and the codex (`codexPassword`, `codexBackup`).

## Generate one
```sh
# 32 random bytes, base64 — the exact format the store expects
openssl rand -base64 32
```

## Set it (Ionos VPS — the blue-green containers)
The two app containers (`pythia-blue`, `pythia-green`) read env at start. Add the key
to the environment the deployer starts them with (the same place `PYTHIA_HUB_HMAC_SECRET`
and the OIDC secrets are injected), then let the normal blue-green deploy roll a fresh
container so it boots with the key:

```sh
# on the host, in the env file the deployer sources for the container run:
PYTHIA_MASTER_KEY=<the hex from openssl>
```

Verify after deploy: open **/admin → Security**. The badge should read **Sealed ✓** with
a `master key #<fingerprint>`. `Plaintext fallback` means the key was not picked up.

## Rotating the master key
Rotation re-seals every entry from the old key to a new one — a generic re-seal (never a
raw key swap). It is an **ops action**, never a browser field (entering a master key into
a web form is exactly the credential handling the safety rules forbid). Procedure:

1. Generate a new key (`openssl rand -base64 32`).
2. While the **old** key is still the live `PYTHIA_MASTER_KEY`, re-seal the store under
   the new key with the tested primitive — e.g. a one-off node script on the host:
   ```js
   import { SealedStore } from "./apps/pythia/dist/codex/sealedStore.js";
   const s = new SealedStore({ dir: "/data/vault", keyProvider: () => decodeBase64(OLD) });
   s.rotateMasterKey(decodeBase64(OLD), decodeBase64(NEW)); // re-seals every entry
   ```
3. Update `PYTHIA_MASTER_KEY` to the **new** key in the deploy env and roll a deploy.
4. Confirm **/admin → Security** shows **Sealed ✓** with the new fingerprint.

If the env key is changed *without* step 2, the store shows **Locked**: the old ciphertext
won't decrypt, the hub feed falls back to the env secret / off, signing is unavailable,
and nothing is lost — restore the correct key or re-set the secrets to recover.

## Losing the key
If `PYTHIA_MASTER_KEY` is lost, the sealed entries are unrecoverable (that is the point).
Recover by **re-setting** them: set a new `PYTHIA_MASTER_KEY`, then re-paste the hub HMAC
secret in **/admin → Connectors → StoaChain → Observation Pool** (the hub owner re-issues
it via `/hub/pythia-admin` if needed), and re-load or re-create the **Codex** in
**/admin → Codex**. Each re-seals under the new key.

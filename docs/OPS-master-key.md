# Ops — the sealed-vault master key (`PYTHIA_MASTER_KEY`)

Pythia seals bearer credentials she must *use* (chiefly the hub M2M HMAC secret) at
rest with **AES-256-GCM**, under a key derived from **`PYTHIA_MASTER_KEY`**. The key
is a **deploy-env secret** — it lives in the container/systemd env, **off the `/data`
volume**, so a leaked volume alone never yields the credentials.

Related: [`docs/HANDOFF-pythia-side-buildout.md`](HANDOFF-pythia-side-buildout.md) (the
hub HMAC secret this seals), `apps/pythia/src/admin/sealedVault.ts` (the implementation).

## What the key is
- Any non-empty string. It is stretched with `scrypt` (per-blob random salt) to a
  256-bit AES key, so a long passphrase or a 32-byte hex string both work. Longer =
  better. Treat it like a root password.
- The vault stores only `{salt, iv, ciphertext, authTag}` per credential — never the
  key, never the plaintext.

## Generate one
```sh
# 32 random bytes, hex — a strong default
openssl rand -hex 32
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

## First run against an existing (plaintext) secret
On the first boot *with* a master key, any hub secret previously stored plaintext in
`pythia-settings.json` is automatically re-sealed into `pythia-vault.json` and removed
from the settings file. No action needed — confirm the Security badge shows **Sealed ✓**.

## Rotating the master key
Rotation re-encrypts the vault from the old key to a new one. It is an **ops action**,
never a browser field (entering a master key into a web form is exactly the credential
handling the safety rules forbid). Procedure:

1. Generate a new key (`openssl rand -hex 32`).
2. While the **old** key is still the live `PYTHIA_MASTER_KEY`, re-seal the vault file
   under the new key with the tested primitive — e.g. a one-off node script on the host:
   ```js
   import { SealedVault } from "./dist/admin/sealedVault.js";
   const v = new SealedVault({ filePath: "/data/pythia-vault.json", masterKey: OLD });
   v.rotateMasterKey(OLD, NEW);   // re-seals every cred; old ciphertext no longer decrypts
   ```
3. Update `PYTHIA_MASTER_KEY` to the **new** key in the deploy env and roll a deploy.
4. Confirm **/admin → Security** shows **Sealed ✓** with the new fingerprint.

If the env key is changed *without* step 2, the vault shows **Locked — key mismatch**:
the old ciphertext won't decrypt, the hub feed falls back to the env secret / off, and
nothing is lost — restore the correct key or re-set the secret to recover.

## Losing the key
If `PYTHIA_MASTER_KEY` is lost, the sealed credentials are unrecoverable (that is the
point). Recover by **re-setting** the secrets: set a new `PYTHIA_MASTER_KEY`, then in
**/admin → Connectors → StoaChain → Observation Pool** paste the hub HMAC secret again
(the hub owner re-issues it via `/hub/pythia-admin` if needed). It re-seals under the new
key.

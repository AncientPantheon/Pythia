# security-vault — Design

## Problem
Pythia holds **bearer credentials it must USE** — chiefly the hub M2M **HMAC
secret** (it signs every feed/usage call with it, so it cannot be hashed). Today
that secret is stored **plaintext** on the mounted `/data` volume
(`admin/settingsStore.ts`), so a volume leak (backup, snapshot, host compromise)
exposes it directly. The **Security** admin tile is a planned-but-empty placeholder.

## Approach
A **sealed vault**: bearer creds are encrypted at rest with **AES-256-GCM** under a
key derived from a **master key**, so the data volume alone never yields the
plaintext. The hub HMAC secret moves from plaintext settings into the vault; the
store is keyed by name so future creds slot in. Keyless: this is at-rest encryption
of *bearer* creds via `node:crypto` — it never signs a blockchain tx or holds a
chain key (same posture as the existing HMAC use in `serviceClient.ts`).

**The master-key model is the one real decision (see the question):**
- **A — env master key (`PYTHIA_MASTER_KEY`, 32 bytes):** the vault auto-unlocks at
  boot; the key lives in the deploy env (systemd/container), *separate from the data
  volume*. Unattended-friendly. **Recommended.**
- **B — admin passphrase:** an ancient enters a passphrase to unlock; the key is
  never persisted. More secure, but the vault **locks on every restart** — the hub
  feed can't run until someone re-unlocks. Bad for an unattended service.

**Dev fallback (no master key):** on localhost / any box with no `PYTHIA_MASTER_KEY`,
the store transparently keeps today's plaintext behavior so dev isn't blocked — the
seal engages exactly when an operator has provisioned a master key. The UI surfaces
which mode is live (Sealed vs Plaintext-fallback), so it is never silent.

**Rotation:**
- *Cred rotation* — set/replace a sealed secret (re-seal) via the existing hub-secret
  "set" flow, now writing through the vault instead of plaintext.
- *Master-key rotation* — a tested `rotateMasterKey(old, new)` operation + a documented
  ops procedure (re-encrypt the vault file under a new key). **Not a browser field** —
  entering a 32-byte master key into a web form is the credential-entry the safety
  rules forbid; master-key handling stays an ops action.

**UI — the Security tile (ancient-gated):** vault status (Sealed / Plaintext-fallback /
Locked-key-mismatch, sealed-cred count, master-key fingerprint), the sealed creds listed
by name (masked, never the value), and a themed-confirm **Clear vault** action for
decommissioning. Secret *values* are set/rotated where they already are — the Hub-feed
panel — which now writes through the vault.

Alternatives rejected: keep plaintext + rely on volume perms (the status quo — a
leak is total); HSM/KMS (overkill for one VPS); passphrase-only (breaks unattended
boot — see B).

## Acceptance criteria
- [ ] A `SealedVault` store seals/unseals named secrets with AES-256-GCM under the
      master key; it persists only ciphertext + iv + authTag on the volume — the
      plaintext secret is never written to disk (verified by inspecting the file).
- [ ] The hub HMAC secret is stored in the vault (sealed); the feed still authenticates
      (unseals at boot with the env master key), with no behavior change when the key
      is present.
- [ ] A missing master key → **Plaintext-fallback** (dev): the secret round-trips as
      today, and the UI shows the mode. A wrong master key (blobs won't decrypt) →
      **Locked**: the secret reads as absent, the feed falls back to env/off, no crash.
- [ ] `SealedVault.rotateMasterKey(old, new)` re-seals every cred under the new key; the
      old ciphertext no longer decrypts. (Tested op + ops doc — no browser key field.)
- [ ] The Security tile (ancient-gated) shows vault status (Sealed / Plaintext-fallback /
      Locked) + master-key fingerprint + sealed creds by name (masked) + a themed-confirm
      Clear-vault action; non-ancient is rejected server-side.
- [ ] `npm test -w @ancientpantheon/pythia` green; keyless CI scanner passes.

## Out of scope
- The OIDC client secret + session secret (stay deploy-env — not runtime-managed).
- HSM/KMS integration; per-credential passphrases; secret sharing/Shamir.

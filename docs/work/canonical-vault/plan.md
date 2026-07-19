# canonical-vault — Plan

Topic 1 of the Pythia sovereign-automaton project (design:
`docs/work/pythia-sovereign-automaton/design.md`). Bring Pythia onto the canonical
`automaton/02` codex-key scheme: ONE libsodium `crypto_secretbox` vault under
`PYTHIA_MASTER_KEY` (32-byte base64), file-based, server-held auto-unlock, generic-re-seal
rotation — retiring the interim AES-GCM `SealedVault` and converging the hub HMAC secret
into it. Foundation for the Codex (Topic 2). Test command: `npm test -w @ancientpantheon/pythia`.

## Wave 1 — the libsodium seal primitive
- [x] T1: `codex/vault.ts` seal/unseal under a 32-byte master key — done when: `parseMasterKey(b64?)`
      returns a `Uint8Array` of exactly 32 bytes or throws a clear error (unset / wrong length);
      `sealWithKey(key, plaintext)` returns base64(`nonce(24) ‖ crypto_secretbox_easy(...)`) and
      `unsealWithKey(key, sealed)` round-trips it; async `seal`/`unseal` use `PYTHIA_MASTER_KEY`
      via `parseMasterKey` after `ensureSodiumReady()`. Tests: round-trip; a different key throws
      on unseal; a non-32-byte key throws; two seals of the same plaintext differ (random nonce);
      the sealed string contains no plaintext.
  - files: `apps/pythia/src/codex/vault.ts`, `apps/pythia/src/codex/vault.test.ts`

## Wave 2 — the file-backed sealed store + generic re-seal rotation (depends on Wave 1)
- [x] T2: `codex/sealedStore.ts` — a file-backed vault of named sealed entries — done when: `set(name,
      plaintext)` writes `<dir>/<name>.sealed` (atomic temp→rename, on `VAULT_DIR` default `/data`
      subdir) sealed via Wave 1; `get(name)` unseals or returns `null` (absent / wrong key — never
      throws); `names()` lists entries; `status()` returns `{ mode: "sealed"|"locked"|"empty",
      unlocked, fingerprint, sealedCount, names }` (fingerprint = first 8 hex of sha256 of the
      master key). `rotateMasterKey(oldB64, newB64)` implements `automaton/02` §4 generic re-seal:
      plan (unseal every entry with OLD, abort before any write on any failure) → re-seal all with
      NEW → write files → return count; the old key no longer decrypts after. Tests: store round-trip
      across a cold reload; the file bytes contain no plaintext; locked/empty status; rotation
      re-seals every entry, old key fails after, data intact; rotation with a wrong old key throws
      without dropping data.
  - files: `apps/pythia/src/codex/sealedStore.ts`, `apps/pythia/src/codex/sealedStore.test.ts`

## Wave 3 — converge the HMAC secret + wiring (depends on Wave 2)
- [x] T3: retire the AES-GCM `SealedVault`; `SettingsStore` seals the hub HMAC secret through the
      libsodium store — done when: `SettingsStore` takes the new store (entry name `hubHmacSecret`),
      `hubConfig()`/`hasSecret()`/`securityStatus()` read through it, keyless/dev → plaintext
      fallback preserved; `index.ts` constructs the libsodium store from `PYTHIA_MASTER_KEY` and
      injects it (replacing `sealedVault`); the admin `security` control + `GET /admin/security`
      report the libsodium store's status; the old `sealedVault.ts`/`sealedVault.test.ts` are removed
      and no code imports them. Existing settings + security route tests updated to the new store and
      green. (No live migration code — the HMAC secret is re-provisioned from the hub at the v2.0
      cutover, per the design.)
  - files: `apps/pythia/src/admin/settingsStore.ts`, `apps/pythia/src/admin/settingsStore.test.ts`, `apps/pythia/src/index.ts`, `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/securityRoutes.test.ts`, `apps/pythia/src/admin/sealedVault.ts` (delete), `apps/pythia/src/admin/sealedVault.test.ts` (delete)

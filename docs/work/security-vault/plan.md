# security-vault — Plan

Serial dependency chain (vault primitive → settings delegate → admin API → UI +
release). Each wave is small; the chain is intrinsic, so waves are mostly one task.

## Wave 1
- [x] T1: `SealedVault` crypto primitive + named-secret store — done when: a new
      `SealedVault` seals a string with **AES-256-GCM** under a key derived
      (`scrypt`) from a master key + per-blob random salt/iv; persists ONLY
      `{v,salt,iv,ct,tag}` base64 per name in a file (atomic temp+rename); `get`
      returns the round-tripped plaintext when unlocked, `null` when the vault is
      locked (no key) or a blob fails to decrypt (wrong key); `status()` returns
      `{ mode: "sealed"|"locked"|"empty", unlocked, fingerprint, sealedCount, names }`
      where `fingerprint` = first 8 hex of `sha256(masterKey)` (never the key);
      `rotateMasterKey(old,new)` re-seals every blob so the old key no longer
      decrypts; `clear()` deletes every named blob and re-persists an empty file; the
      plaintext value is never written to the persisted file (asserted by reading the
      file bytes). Tests cover: seal/unseal round-trip, locked→null, wrong-key→null,
      file-has-no-plaintext, fingerprint stability + non-reversibility, rotateMasterKey
      re-seals, clear empties.
  - files: `apps/pythia/src/admin/sealedVault.ts`, `apps/pythia/src/admin/sealedVault.test.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: `SettingsStore` seals the hub HMAC secret through the vault — done when:
      `SettingsStore` accepts an optional `vault: SealedVault`; when the vault is
      **unlocked**, the hub secret is stored/read via `vault` under name
      `"hubHmacSecret"` (never in `settings.json`), and any pre-existing plaintext
      `hmacSecret` in `settings.json` is migrated into the vault and stripped on load;
      when the vault is **locked/absent**, behavior is exactly today's plaintext path
      (dev fallback); `hubConfig()`, `hasSecret()`, and the reveal path all read the
      effective secret regardless of mode; a new `securityStatus()` exposes the vault
      `status()` plus a `plaintextFallback` boolean for the admin API. All existing
      `settingsStore.test.ts` cases (no-vault plaintext) stay green; new tests cover:
      sealed round-trip via an unlocked vault, `settings.json` never contains the secret
      when sealed, legacy-plaintext migration on load, locked-vault→plaintext fallback.
  - files: `apps/pythia/src/admin/settingsStore.ts`, `apps/pythia/src/admin/settingsStore.test.ts`

## Wave 3 (depends on Wave 2)
- [x] T3: Admin Security API + wiring — done when: (routes at `/admin/security` +
      `/admin/security/clear` — the codebase convention, not the `/api/admin/…` the
      plan first guessed) `index.ts` constructs
      `export const sealedVault = new SealedVault({ filePath: process.env.VAULT_FILE || "./pythia-vault.json", masterKey: process.env.PYTHIA_MASTER_KEY })`
      and passes `vault: sealedVault` into the `SettingsStore`; `registerAdmin`'s
      `AdminExtras` gains `security?: { status(): SecurityStatus; clear(): void }`
      wired from `settingsStore.securityStatus()` + `sealedVault.clear()`; `routes.ts`
      registers ancient-gated `GET /api/admin/security` (returns the status: mode,
      fingerprint, sealedCount, names, plaintextFallback) and `POST /api/admin/security/clear`
      (deletes all sealed creds, returns the new status); a non-ancient session gets the
      same 401/403 as the other admin routes. Tests (a `securityRoutes.test.ts` modeled
      on `pythRoutes.test.ts`) cover: gated GET returns the injected status shape, POST
      clear invokes `clear()` and returns updated status, unauthenticated → rejected.
  - files: `apps/pythia/src/index.ts`, `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/securityRoutes.test.ts`

## Wave 4 (depends on Wave 3)
- [x] T4: Security admin tile UI — done when: `admin.js` flips the `security` tile to
      `enabled: true`, adds a `#security` VIEW_LOADER that fetches `GET /api/admin/security`
      and renders: the mode badge (Sealed ✓ / Plaintext-fallback ⚠ / Locked ⚠), the
      master-key fingerprint, the sealed creds listed by name (masked — value never shown),
      and a **Clear vault** button guarded by the shared `confirmDialog` (danger) that POSTs
      `/api/admin/security/clear` and re-renders; `admin.html`/`styles.css` get only the
      markup/classes the view needs (reuse existing panel/list vocabulary). Done when
      `node --check apps/pythia/public/admin.js` passes and a browser check shows the tile
      opening, the status rendering, and the clear-confirm modal appearing.
  - files: `apps/pythia/public/admin.js`, `apps/pythia/public/admin.html`, `apps/pythia/public/styles.css`
- [x] T5: Release 1.10.0 + ops doc — done when: the four version files
      (`package.json`, `apps/pythia/package.json`, `packages/pythia-client/package.json`,
      `apps/pythia/src/version.ts`) all read `1.10.0`, `CHANGELOG.md` gains a top
      `## [1.10.0]` entry describing the sealed vault, a short `docs/OPS-master-key.md`
      documents generating/setting `PYTHIA_MASTER_KEY` + the `rotateMasterKey` procedure,
      and `versionConsistency.test.ts` passes.
  - files: `package.json`, `apps/pythia/package.json`, `packages/pythia-client/package.json`, `apps/pythia/src/version.ts`, `CHANGELOG.md`, `docs/OPS-master-key.md`

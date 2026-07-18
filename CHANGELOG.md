# Changelog

All notable changes to the Pythia repo/service are documented here, newest first. This
project follows [Semantic Versioning](https://semver.org). The version in the **top entry**
MUST equal the root `package.json`'s `version` (and, in turn, `packages/pythia-client/package.json`,
`apps/pythia/package.json`, and `apps/pythia/src/version.ts`) — this is enforced by
`apps/pythia/src/versionConsistency.test.ts`, so every version bump ships its own documentation.

Note: this is the **repo/service** changelog. The npm client's own change history lives in
[`packages/pythia-client/CHANGELOG.md`](packages/pythia-client/CHANGELOG.md).

## [1.11.0] — 2026-07-18

### Added
- **Observation Pool now shows the whole hub fleet.** The admin Observation Pool renders
  one row per advertised hub node — IP, server URL, operator, at-tip — each with a
  **reachability dot probed from Pythia's own vantage** (`GET <url>/info`, HTTPS, 3s,
  cert-validated) and, when red, the **reason** (`refused` / `timeout` / `dns` / `cert` /
  `http <status>`) so a dead node is diagnosable at a glance instead of an opaque red dot.
  Per-node **earnings** (operator PythXP/level + the slot's stoicism/rewarded-requests)
  render when the hub returns them and degrade to "awaiting hub" until it does. Served by a
  new ancient-gated `GET /admin/hub-nodes`; the feed now retains the full advertised slot
  list (not just a count).

### Changed
- **Update & Deploy is version + deploy only.** The per-node reachability rows moved to the
  Observation Pool (their proper home); Update & Deploy keeps the live Version readout and
  the Deploy controls, and its stale "reports only the two config seed nodes" note is
  corrected.

## [1.10.1] — 2026-07-18

### Fixed
- **Sealed vault now persists across deploys.** `VAULT_FILE` was unset, so the vault
  defaulted to the ephemeral container filesystem (`/app/pythia-vault.json`) while
  settings live on the `/data` volume — the boot migration stripped the plaintext hub
  secret from persistent settings and sealed it into a file that a redeploy would wipe.
  The Dockerfile now bakes `VAULT_FILE=/data/vault.json`, co-located with
  `SETTINGS_FILE`, so the sealed credential survives redeploys.

## [1.10.0] — 2026-07-18

### Added
- **Sealed credential vault.** The bearer credentials Pythia must *use* — chiefly the
  hub M2M HMAC secret — are now **encrypted at rest** (AES-256-GCM) under a master key
  taken from the deploy env (`PYTHIA_MASTER_KEY`), which lives off the data volume. A
  leaked volume/backup no longer exposes the secret; you also need the master key. The
  key auto-unlocks the vault on boot, so the hub feed keeps signing across restarts with
  no human present — the admin login gates *management*, not decryption. Any pre-existing
  plaintext secret is migrated into the vault and stripped on first load. With no master
  key set (dev), the store transparently keeps the old plaintext behavior, surfaced in
  the UI so it is never silent. Master-key rotation is a tested `rotateMasterKey` op +
  a documented procedure ([`docs/OPS-master-key.md`](docs/OPS-master-key.md)) — never a
  browser field.
- **"Security" admin tab** (ancient-gated): the vault status (Sealed / Plaintext-fallback
  / Locked), the master-key fingerprint, the sealed credentials listed by name (masked —
  never the value), and a themed-confirm **Clear vault** decommission action.

## [1.9.1] — 2026-07-18

### Changed
- **Pool robustness.** `/healthz` is now **pool-aware** — it reports the nodes actually
  serving reads (the live hub pair or the Upload Pool), not just the two config seed
  nodes, so its status can't contradict the real read path. The node pool now **honors
  the hub feed's `refreshAfter`** (a self-rescheduling poll, clamped 15s–5m) instead of
  a fixed 60s cadence, and **drops stale hub slots after a TTL** (3m) so a de-listed
  node stops receiving reads after an outage (reads fall back to the Upload Pool).
- **In-theme confirmations everywhere.** Every destructive/confirm action (Deploy,
  Nuke the Pyth ledger, remove verifier/upload-pool node) now uses the site's themed
  modal instead of the browser's `window.confirm`.

### Removed
- ~396 lines of dead hub/txsender code in the landing's `app.js` (superseded by the
  `/admin` dashboard); two stale code comments corrected.

## [1.9.0] — 2026-07-18

### Added
- **Hub usage reporting (the minting feed).** Pythia now reports her served reads to
  the AncientHub so node operators actually mint — the outbound half of the Pyth
  economy. Every ~60s she drains a **per-slot** window (`keyedRequests` /
  `anonRequests` / `ok` + `keyedPondus`, attributed to each hub node by slot id) and
  POSTs a signed report to `POST /api/pythia/usage/`. Only **keyed reads served by
  hub-pool nodes** earn; Upload-Pool/seed reads, sends, and polls never do.
  - **Execution-accurate weight.** The report carries `keyedPondus` (PONDUS_V1) +
    `pondusVersion: 1`, so heavier reads earn more, from row one.
  - **Money-path safety.** Windows are contiguous, non-overlapping, and immutable; a
    failed POST is retried unchanged (idempotent, first-write-wins on the hub); empty
    windows are skipped.
  - **Honours the Report-to-hub toggle** (StoaChain Earnings): OFF keeps counting
    locally but reports nothing — that span never mints — while Pythia's own fleet
    ledger keeps accruing.

### Changed
- `dial()` gains an optional `onServed(node)` hook (surgical; the 15 callers are
  byte-identical without it) so a read can be attributed to the hub slot that served
  it; `NodePool` now exposes `operatorForSlot(id)`.

## [1.8.0] — 2026-07-18

### Added
- **Pyth-economy metering (keyless).** Pythia now meters the service she provides into a fleet-wide
  ledger: **Petitions + Pondus** for keyed reads (`PONDUS_V1 = classBase + √gas/2 + bytes/4096`,
  applied per request) and **Transactions + Gas** for relayed sends. It is **execution-level** — a
  self-polling tracker resolves each relayed tx to its mined outcome (a success counts its *actual*
  gas; a revert counts as a failed tx with its *actual* wasted gas; a tx that never mines times out
  as failed). The ledger keeps per-day deltas ready for a future on-chain daily flush.
- **Activity is now the Pyth economy.** The StoaChain Activity view shows **Petitions · Pondus** and
  **Transactions · Gas relayed** (plus Failed / Wasted) with a daily-petitions chart, served by a new
  keyless `GET /pyth`. The old Errors card and Poll metric are gone; Activity is per-chain
  (StoaChain / Arweave) in the header tier-2.
- **"StoaChain Earnings" admin tab** (ancient-gated): the six ledger totals, a confirm-guarded
  **Nuke the ledger** reset, and a **Report-to-hub** on/off switch.

### Changed
- **Landing reshaped into a fixed-size single-screen page.** A three-level sticky Pantheonic Header
  (full-chrome-width separator; Tier-1 sections + Tier-2 sub-navigation both live only in the header),
  a full-height Pythia portrait with a collapse toggle, and a work-area that fills the page and scrolls
  internally. Widened to 1760px. (Codified in the Pantheonic Architecture library, `design/` v1.2.)

### Notes
- Outbound **hub usage reporting** (Pythia → hub, which drives B.UNA / Stoicism minting) lands in the
  next release; the Report-to-hub toggle already ships as the setting it will honour.

## [1.7.0] — 2026-07-15

### Changed
- **Version unified across the workspace.** Root `package.json`, `packages/pythia-client/package.json`,
  `apps/pythia/package.json`, and `apps/pythia/src/version.ts` now all carry the same version. The
  client jumps `1.1.0 → 1.7.0` to align with the service (previously drifted, `1.1.0` vs `1.6.0`).

### Added
- **GHCR container image publish** (`.github/workflows/image.yml`) — a `v*` tag now also builds and
  pushes `ghcr.io/ancientpantheon/pythia:<semver>` + `:latest`, alongside the existing npm publish of
  `@ancientpantheon/pythia-client`, from the same tag.
- **Versioning gate** — a new `apps/pythia/src/versionConsistency.test.ts` asserts the four version-bearing
  files agree with each other and with this changelog's newest `## [x.y.z]` entry, and this root
  `CHANGELOG.md` itself, so a version bump can no longer merge undocumented or with the two
  artifacts silently diverging.

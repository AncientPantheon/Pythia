# Changelog

All notable changes to the Pythia repo/service are documented here, newest first. This
project follows [Semantic Versioning](https://semver.org). The version in the **top entry**
MUST equal the root `package.json`'s `version` (and, in turn, `packages/pythia-client/package.json`,
`apps/pythia/package.json`, and `apps/pythia/src/version.ts`) — this is enforced by
`apps/pythia/src/versionConsistency.test.ts`, so every version bump ships its own documentation.

Note: this is the **repo/service** changelog. The npm client's own change history lives in
[`packages/pythia-client/CHANGELOG.md`](packages/pythia-client/CHANGELOG.md).

## [2.1.0] — 2026-07-21

### Fixed
- **Deploy confirm no longer shows on its own.** The inline confirm's `display:flex` class
  was defeating its `hidden` attribute, so the Yes/Cancel card was always visible. Added the
  `[hidden]` override (as the rest of the admin does) so it appears only when Deploy is
  clicked — now a bit below the button (kept visible) instead of flush against it.

### Added
- **On-chain Pyth-ledger flush (Khronoton drain model).** Pythia can now feed her local
  per-UTC-day ledger to the on-chain `PYTHIA|A_Flush(entries)` transaction via a Khronoton
  cronoton, with no sealed-day tracking:
  - The ledger builds flush entries in the exact Pact `PythFlushEntry` shape — integer
    `day` ordinal (epoch `2026-07-21`), `iz-complete` derived (past day = sealed, today =
    open), kebab-case keys, `pondus` ≤3dp — oldest-first, capped at 1000/tx.
  - A **`pyth-flush` single-tx server resolver** fills the cronoton's `entries` payload at
    fire time and **drains** the sent buckets only on confirmed on-chain success (a failed
    or unfired flush retries next tick; traffic arriving mid-flush is preserved).
  - The **StoaChain Earnings** panel warns when more than two day-buckets are unflushed
    (a stuck daily flush).
  - Operators wire the flush as a cronoton in the Khronoton console — see
    `docs/work/pyth-flush/design.md` and the cronoton setup guide.

## [2.0.4] — 2026-07-21

### Changed
- **Deploy confirmation is now inline, not a popup** (matches Mnemosyne). Clicking Deploy
  swaps the button for a "Yes, deploy / Cancel" confirm row in the same card; Cancel swaps
  back. No modal dialog.
- **Breathing room above the Deploy button** — the on-box deploy controls gained top spacing
  so the button no longer crowds the note above it.
- **Readable content links.** Links inside admin notes (e.g. the "Blockchain Connectors →
  StoaChain → Observation Pool" cross-reference) used the browser-default violet, unreadable
  on the dark panel; they now render in the gold accent with an underline.

## [2.0.3] — 2026-07-21

### Changed
- **Codex top-bar Download / Load buttons now stack vertically** (one below the other),
  matching Mnemosyne's codex layout, instead of sitting side-by-side.

## [2.0.2] — 2026-07-21

### Changed
- **Update & Deploy now matches the canonical Pantheon deploy window (Mnemosyne-style).**
  The whole view lives in one framed card instead of free-floating text: the version
  readout is grouped into **Pythia** and **Constructors**, each as a framed row showing
  the name + package and installed → available version chips (an update chip when newer,
  "up to date" when equal); the on-box deploy status, Deploy button, and the streaming
  build terminal sit in the same card. The version payload now carries each organ's npm
  package name so the rows can show `Codex · @ancientpantheon/codex`.

## [2.0.1] — 2026-07-21

### Fixed
- **Codex UI, aligned to the canonical Pantheon codex layout + no more silent unlock
  failures.** Three fixes to the admin Codex console:
  - Removed the redundant **Lock/Unlock** button from the top bar — the single lock/unlock
    control now lives only in the CODEXID identity row (matching Mnemosyne / the codex spec:
    Download + Load up top, lock/unlock in the identity row).
  - Fixed the **auto-lock debouncer positioning** — the top-bar actions and the debouncer
    now sit centered on one row and no longer wrap/misalign.
  - When the admin session has lapsed, the Codex now shows a clear **"session expired —
    reload and sign in again"** banner instead of silently staying Locked with a dead unlock
    button, and it no longer retries the unlock endpoint in a loop. With a valid session the
    codex auto-unlocks as before.

## [2.0.0] — 2026-07-20

**Pythia becomes a sovereign Pantheonic Automaton.** She keeps her keyless read/relay
face for clients — now named **Pythiaeyes** — and gains a keyed sovereign core that can
hold keys and sign her own on-chain transactions. The client-facing guarantee is
unchanged: Pythiaeyes never holds a key and never signs.

### Added
- **Codex organ.** Pythia's own sealed key vault with the full Mnemosyne Codex UI baked
  in (add keys to an empty codex, load an existing codex, download it re-encrypted under
  a chosen password, reload it re-sealed under the key Pythia holds). Server-custody
  adapter under `/admin/codex`; the React console mounts in the admin (Codex tile).
- **Khronoton organ.** Scheduled autonomous signing. The tick engine boots dormant with
  the app (better-sqlite3 cronoton store, the StoaChain runtime, and a codex-backed key
  resolver that unseals the exact signing key per pubkey and refuses the wrong/unknown
  key). Ancient-gated admin API under `/admin/khronoton` plus the full Cronoton console
  (list / detail / builder) in the admin (Khronoton tile) — set the cronotons Pythia
  fires on-chain, with the gas paid by the Ouronet gas station (she signs only).
- **Sealed-credential store** upgraded to a directory of per-entry `<name>.sealed`
  entries, sealing the hub HMAC secret AND Pythia's operator codex (password + backup)
  at rest under a single `PYTHIA_MASTER_KEY` — the same libsodium scheme as the hub and
  Mnemosyne. Auto-unlock at boot; locked (reads only, no signing) when the key is absent.
- **Multi-version readout.** The Update & Deploy panel now shows the entity plus each
  automaton organ — Pythia, Codex, Khronoton — installed→available with per-organ update
  badges (Mnemosyne-style).

### Changed
- **The keyless invariant is reframed, not dropped.** It now guarantees the **Pythiaeyes
  constructor face** (the client request path) holds no keys, enforced by the keyless
  scanner PLUS a hard isolation boundary: no module outside `src/automaton/` may import
  the keyed core (`scanForAutomatonImports`). A client request can never reach the Codex
  or a signature.
- **Container.** The image now builds the native `better-sqlite3` addon and both React
  admin islands; the sealed store and cronoton store live on the `/data` volume
  (`PYTHIA_VAULT_DIR=/data/vault`, `PYTHIA_KHRONOTON_DIR=/data/khronoton`), replacing the
  single-file `VAULT_FILE`.

### Operator notes (cutover)
- Generate a base64 32-byte `PYTHIA_MASTER_KEY` on the box and supply it to the
  container; without it Pythia serves reads but cannot unseal the vault or sign.
- The vault moved from a single JSON file to a directory store, so the hub HMAC secret
  must be re-pasted once after the cutover (Security panel).

## [1.13.1] — 2026-07-19

### Fixed
- **The Pyth ledger now survives redeploys.** `PYTH_LEDGER_FILE` was never set, so the
  Activity/Earnings ledger (Petitions/Pondus + Transactions/Gas) defaulted to the ephemeral
  container filesystem — every deploy or restart started a fresh container with an empty
  ledger, so accumulated reads vanished. The Dockerfile now bakes
  `PYTH_LEDGER_FILE=/data/pyth-ledger.json`, co-located with the other `/data` stores, so
  the counts persist across deploys. (Unrelated to the 1.13.0 deep-link change.)

## [1.13.0] — 2026-07-19

### Changed
- **Every landing view now has its own URL** (Pantheonic Architecture §3.7). The landing's
  Tier-1 sections and Tier-2 sub-views are addressable, deep-linkable, and back-navigable —
  `#chains`, `#activity/arweave`, `#connectors/register`, etc. The URL hash is the source of
  truth: the shown view is derived from it on load and on every `hashchange` (Back/forward
  and programmatic nav), instead of flipping panels in memory behind a single opaque URL. A
  bare section (`#connectors`) resolves deterministically to its first sub-view, so the same
  URL always renders the same view. (The admin already followed this model.)

## [1.12.2] — 2026-07-19

### Changed
- **Anonymous reads now count in Pythia's own ledger.** Every served read/poll — including
  anonymous (non-Pythia-keyed) ones — now moves Pythia's **Petitions + Pondus** (her own
  service volume, observational). The **minting path is unchanged**: only *keyed* reads
  served by *hub* nodes contribute earning Pondus to the per-slot hub report, so an
  anonymous read counts for Pythia but earns no operator any PythXP. Sends remain
  Transactions/Gas and never mint. (Previously anonymous reads were served but not metered
  at all, so a plain dirty read left the ledger at zero.)

## [1.12.1] — 2026-07-18

### Changed
- **StoaChain connectors: a dedicated "Hub Feed" tab.** The hub base URL + HMAC secret
  form now lives in its own first sub-tab (**Hub Feed · Observation Pool · Upload Pool ·
  Routing Rules**), so connecting to the hub is separated from observing the fleet.
  Observation Pool is now purely the hub-fleet node table.

## [1.12.0] — 2026-07-18

### Added
- **Update & Deploy shows installed → available.** The panel now reads the version
  running vs. the version a deploy would build (the repo's `main`, read from public
  GitHub), Mnemosyne-style: `Installed v1.11.0 → v1.12.0 · update available`, or "up to
  date" when equal, or "latest: unreachable" if the repo can't be read. Served by a new
  ancient-gated `GET /admin/version-info`.

### Fixed
- **Observation Pool node row no longer overflows on a long operator.** The hub is
  currently sending a garbled/over-long `operator` value; the row now truncates it (with
  the full value on hover) instead of letting it overflow and overlap the node's IP.

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

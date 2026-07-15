# card-admin — Design

> Topic 2 of the **pythia-constructor-service** project. Restructure the sub-tabbed `/admin` into a
> Mnemosyne-style **tile-per-function** landing behind a shared **AdminGate**, adding all admin
> functions as tiles. Stack: Hono + vanilla HTML/JS (adapt Mnemosyne's React pattern, don't copy).

## Problem
Pythia's `/admin` ([apps/pythia/public/admin.html](../../../apps/pythia/public/admin.html) +
[admin.js](../../../apps/pythia/public/admin.js)) is a flat three-sub-tab strip (Verifiers ·
Observation Pool · Upload Pool). The Mnemosyne blueprint (§9) — the shape the owner wants — is a
**landing with a tile per function**, each opening its own gated view, all wrapped in one shared
`AdminGate` that owns the auth states. Pythia's version is also missing operator tiles the blueprint
expects (a Deploy/Update surface, a Security surface, a Version/Network readout), and it has no
at-a-glance "what's live / what's healthy" view even though `/healthz` already returns it.

## Approach
**Single-page, hash-routed tiles** in the existing `admin.html` + `admin.js` (one shell, one script):

- **AdminGate** — formalize the existing `applyGate()` into a gate that owns the four states the
  blueprint names: *checking* (before `/api/me` resolves) → *logged-out* (login prompt) →
  *logged-in-but-not-ancient* (not-authorized notice) → *ancient* (render the dashboard). The gate
  wraps the whole surface; server-side `/admin/*` gating is unchanged (the gate is UX only).
- **Tile landing** — when ancient, show a grid of function cards built from a static tile-config
  array (id, icon, title, blurb, target hash, enabled). This mirrors Mnemosyne's `AdminLanding`
  `ENTRIES` array, in vanilla.
- **Hash-routed views** — clicking a tile sets `location.hash` (e.g. `#verifiers`); a tiny router
  shows that function's panel and hides the landing, with a "← Dashboard" back link. The three
  existing panels (verifiers / observation / upload) become views unchanged — their load/render/wire
  functions already target stable element IDs and are reused verbatim. Deep-link + reload land on the
  view; browser Back returns to the landing.

**Tile set** — six tiles, matching the blueprint shape:
| Tile | State | Backing |
|---|---|---|
| 🔐 Verifiers | working | existing `/admin/verifiers` (deepened in topic 3) |
| 🛰️ Observation Pool | working | existing `/admin/hub-config` |
| 📤 Upload Pool | working | existing `/admin/tx-senders` |
| 📟 Version & Network | working (new) | reads `/healthz` — live `PYTHIA_VERSION` + per-source reachability |
| ⬆️ Update & Deploy | **planned** (disabled) | on-box deploy backend deferred to a later round |
| 🔑 Security | **planned** (disabled) | master-key sealed-creds vault deferred to a later round |

Deferred-backend tiles render **disabled with a "planned" badge** — present so the board reflects the
full intended shape, but never wired to a nonexistent endpoint (clicking shows a short "coming in a
later round" note, not a broken view).

**Alternatives considered:**
- *Separate HTML page per function* (`/admin/verifiers.html` …, each served by Hono) — closer to
  Mnemosyne's literal per-route structure, but duplicates the shell + gate across pages and adds
  server routes; rejected — more code, less DRY, no benefit for a static vanilla admin.
- *Keep the sub-tab strip, just restyle it as cards* — rejected: the blueprint's model is a landing
  you navigate into, not a permanent tab bar; hash-routing gives real per-function URLs.

## Acceptance criteria
- [ ] Signed in as an ancient admin, `/admin` shows a **grid of function tiles** (not the old sub-tab
      strip) as its landing.
- [ ] The shared gate shows the correct state for each case: not-signed-in → a login prompt;
      signed-in-but-not-ancient → a "requires the ancient role" notice; ancient → the tile landing;
      and a brief checking state before `/api/me` resolves.
- [ ] Clicking the **Verifiers**, **Observation Pool**, or **Upload Pool** tile opens that function's
      view with a working "← Dashboard" back link, and every existing action there still works (add /
      enable / remove verifier; save + refresh hub config; add / enable / remove / bulk-add tx-sender).
- [ ] A **Version & Network** tile view shows the live `PYTHIA_VERSION` and each source's
      reachability, read from `/healthz`.
- [ ] The **Update & Deploy** and **Security** tiles are visible but disabled with a "planned" badge,
      and do not call any backend.
- [ ] Visiting `/admin#verifiers` directly (or reloading on it) opens the Verifiers view; browser
      Back returns to the landing.
- [ ] A non-ancient or signed-out visitor never sees the tiles or any function view; all `/admin/*`
      mutations remain server-gated (unchanged).
- [ ] The full test suite stays green; `npm run build` + typecheck clean.

## Out of scope
- The on-box **Deploy** button backend (host systemd deployer, Caddy blue-green, SSE) — later round.
- The master-key **sealed-creds vault** (Security tile backend) — later round.
- **Verifier embeddable two-tier** registry (baked-in `config/verifiers.json` + embed flow) — that's
  topic 3 (embeddable-verifiers); this topic only relocates the existing Verifiers panel into a tile.
- The localhost OIDC port reconciliation — owner is keeping local dev on **3006** (callback pinned
  there); not a code deliverable here.
- Any change to the public landing page beyond the existing ancient-only "Admin" link.

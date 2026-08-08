# Connector activate / deactivate from the API-keys list — Design

## Problem
On `#connectors` (the full-API-keys list) there is no way to **activate** an already-linked-but-INACTIVE
dual link, nor to **deactivate** an active one. Inactive links now exist because Codex's `C_Link` links
two owned keys on-chain but leaves them inactive — only Pythia running `A_Link` activates them. The
register sub-view only handles two freshly-picked UNLINKED halves; it can't touch an existing link.

## Approach
Make the dual-link rows **selectable** and attach two context-aware actions driven by the selected row's
state and the viewer's role.

### 1 · Activate an INACTIVE link — "API Link" (login-agnostic)
Available to **anyone** (hub-logged-in or not), mirroring the existing autonomous A_Link flow.

- Selecting an inactive row exposes **"Verify & Activate (API Link)"**.
- It drives the **existing** browser verify flow — `POST /api/connectors/verify/start` → deep-link to a
  curated verifier's `/apollo-verify` → `/connectors/verify/callback` → `GET /api/connectors/verify/status`
  — but **seeded with the row's two halves** (`standard-apollo`, `smart-apollo`) instead of the
  register view's picked-halves state. The verify backend proves ownership of whatever pair it's given
  (no unlinked requirement — that gate is frontend-only), so an already-linked pair verifies fine.
- When both halves are proven, `pendingActivationTracker.recordProof` fires `onPairReady` →
  `dual-link-activate` resolver → autonomous `A_LinkDualApiKey`, which is idempotent (activate-or-create).
  The row reflects the phase (`pending` → `activating` → `activated`), reusing the register view's
  activation-status polling.
- **Backend: essentially unchanged.** Reuse verify + tracker + resolver + trigger as-is. Only relax any
  server guard that would reject verifying an already-linked pair (confirm during build; the map says
  there is none — recordProof is counterpart-agnostic).

### 2 · Deactivate an ACTIVE link — "API Break" (ancient admin only)
Visible/triggerable **only when the ancient admin is logged in** (`/api/me` → `isAncient()`), same label
format as "API Link".

- Selecting an active row, **as ancient**, exposes **"Deactivate (API Break)"** (a destructive action —
  confirm dialog).
- It calls a NEW **ancient-gated** route `POST /admin/connectors/break` — modeled exactly on the
  force-delete precedent: `createAdminGate(cfg)` (401/403) + an `x-pythia-confirmed: 1` header (else
  `admin_confirm_required`) + `onAudit({ action: "dual_link.break", actor })`.
- The route records the target pair in a new **`pendingBreakTracker`** (mirroring
  `pendingActivationTracker`) and fires the **`dual-link-break`** cronoton via `executeNow`
  (`findCodexCronotonIdByServerResolver("dual-link-break")`).
- **A_Break itself is the operator's follow-up** — the Khronoton `dualLinkBreakResolver` + the on-chain
  deactivate capability do NOT exist yet (operator adds them after this lands). So if no cronoton is
  bound to `dual-link-break`, the route responds clearly: `503 { code: "break_resolver_unregistered" }`
  ("the A_Break deactivation function is not yet registered") — the button works end-to-end the moment
  the operator drops in the resolver. This is the chosen **(a)** approach (build the full path now,
  graceful-pending until A_Break exists), not a disabled stub.
- I build the **contract the operator's resolver plugs into**: `pendingBreakTracker` with
  `recordBreak(standard, smart)` / `beginBreak()` / `commitBreak(token)` (same shape as activation), so
  the future `dual-link-break` resolver's `resolve()` reads the target pair from it. `"dual-link-break"`
  is added to `EVENTED_SERVER_RESOLVERS` so its cronoton is scheduleless/evented like activation.

### Alternatives considered
- *Add a manual "Activate" button that directly fires A_Link without re-verifying* — rejected: activation
  must be gated on proof-of-ownership of both halves (the whole security model); reuse the verify flow.
- *Build the full A_Break resolver + pact now* — rejected: the operator explicitly owns that follow-up;
  we build the UI + route + tracker + evented slot it plugs into, graceful-pending until it lands.

## Acceptance criteria
- [ ] Dual-link rows are single-selectable; selecting one reveals a context action bar.
- [ ] Selecting an INACTIVE row (as ANY viewer, logged in or not) offers "Verify & Activate (API Link)",
      which drives the existing verify flow seeded with that row's two halves and, on both-proven,
      autonomously activates via A_Link; the row shows pending → activating → activated.
- [ ] Selecting an ACTIVE row shows NO break action unless the viewer is the ancient admin.
- [ ] As ancient, selecting an ACTIVE row offers "Deactivate (API Break)" (with confirm); it calls the
      ancient-gated `POST /admin/connectors/break` (gate + confirm + audit) which records the pair and
      fires the `dual-link-break` cronoton — or returns a clear `503 break_resolver_unregistered` while
      A_Break is not yet added.
- [ ] A non-ancient (or anonymous) caller hitting the break route directly gets `401/403`.
- [ ] `pendingBreakTracker` exists with recordBreak/beginBreak/commitBreak + tests; `"dual-link-break"`
      is in the evented registry. Full `npm test` + typecheck green.
- [ ] Ships as a SERVICE-only release: the client package stays at 3.0.0, only the service bumps.

## Out of scope (operator's follow-up)
- The `dualLinkBreakResolver` (the Khronoton A_Break resolver) and the on-chain deactivate/`A_Break`
  pact capability — the operator adds these after; this design builds the tracker/route/UI/evented-slot
  they plug into.
- Any change to the register sub-view (unlinked-halves flow) — untouched.

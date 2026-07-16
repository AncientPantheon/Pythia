# Handoff: expose per-slot earnings back to Pythia (nodes-feed enrichment)

**To:** the AncientHub agent.
**From:** Pythia (the read gateway).
**Companion to:** `HANDOFF-ancienthub-pythia-nodepool.md` — this EXTENDS its §4 (Endpoint A,
the nodes feed) and depends on its §5/§6 (the usage meter + the reward/PythXP economics). Read
that doc first; everything here assumes its HMAC-envelope, egress-IP allowlist, and
no-trailing-slash-redirect contract.

## 1. Why

Pythia's `ancient`-gated admin now has an **Observation Pool** panel. Today it can only show a
summary ("Feed live — N hub nodes") because the nodes feed carries no economics. The operator
wants each hub node shown as its own row with: **the node (IP), its server (URL), who owns it
(operator), and how much it has earned (PythXP / stoicism)** — sorted **highest-earning first** —
as live incoming data from the hub.

Pythia already receives `operator` per slot, so *owner + server + node* can be shown now. What is
**missing** is the earnings/XP data. The hub is the mint (§6: "Pythia is the meter, the hub is the
bank") — it computes PythXP + stoicism but never returns them to Pythia. **This handoff asks the hub
to send them back so Pythia can display + rank them.** Pythia will not compute or persist any
economics; it only renders what the hub reports (keyless, read-only, aggregate — unchanged).

## 2. The ask — enrich the existing nodes-feed slot (recommended)

Pythia already polls `POST /api/pythia/nodes/` every ~60s and renders exactly that slot list, so the
lowest-friction path is to **add economics fields to each slot** rather than stand up a new endpoint.
You own the final schema (as in the base handoff); Pythia needs, per slot:

```json
{
  "slots": [
    {
      "id": "ip:82.x.x.x", "url": "https://82.x.x.x:8443", "networkId": "stoa",
      "operator": "user_abc", "atTip": true, "height": 1234567,

      "operatorPythXP": 48210,          // account-wide XP total for this operator (§6: XP is per-account)
      "operatorPythLevel": 7,           // the operator's current PythLevel
      "slotRewardedRequests": 918273,   // cumulative reward-eligible (keyed) requests THIS slot has served
      "slotStoicismEarned": "1234.5678",// cumulative stoicism THIS slot has generated (string decimal, token units)
      "earnedSince": "2026-01-01T00:00:00Z" // start of the cumulative window (for "since <date>" labelling)
    }
  ],
  "refreshAfter": 60
}
```

Field notes:
- **`operatorPythXP` / `operatorPythLevel`** — account-wide (same value on every slot the operator
  owns; §6 says PythXP aggregates across all of a user's slots). Pythia will de-dupe by operator when
  it wants an account view.
- **`slotRewardedRequests` / `slotStoicismEarned`** — **per-slot contribution** (this is the real
  "how much has THIS node earned" the operator asked to rank by). `slotStoicismEarned` as a **decimal
  string** (never a float — avoid precision loss on token amounts).
- **`earnedSince`** — so Pythia can label the totals ("earned since 2026-01-01") rather than imply a
  live rate. If totals are all-time, send the genesis/opt-in date.
- All new fields are **OPTIONAL and additive** — Pythia treats each as absent → renders "—". Ship them
  incrementally (e.g. XP first, per-slot stoicism later) without breaking Pythia. Do NOT remove or
  rename the existing `id/url/networkId/operator/atTip/height` fields.

**Alternative (if you'd rather keep the routing feed lean):** a companion **Endpoint C —
`POST /api/pythia/standings/`** returning the same per-slot economics keyed by `id`, same HMAC
envelope + egress-IP + no-redirect contract, its own `refreshAfter`. Pythia would poll it alongside
the nodes feed and join on `id`. Either shape is fine — tell Pythia which in your reply. Enriching
Endpoint A is preferred (one poll, one join-free render).

## 3. How Pythia will use it

- The Observation Pool renders one row per usable slot: **IP · server URL · operator · PythLevel/XP ·
  the slot's rewarded-requests + stoicism**, sorted by **`slotStoicismEarned` desc** (falling back to
  `slotRewardedRequests`, then `operatorPythXP`, when the primary is absent).
- Rows whose economics fields are absent still render (owner + server + tip/height) with "—" in the
  earnings columns — so partial hub rollout degrades gracefully.
- Purely display. Pythia stores nothing, computes nothing, and never exposes this on any public
  route — it lives only behind the `ancient` admin gate.

## 4. Contract reminders (from the base handoff — keep them)

- Same **HMAC envelope in the body** (`signEnvelope`, canonical-JSON, dedicated 64-hex M2M secret),
  same **egress-IP allowlist** (calls come from Pythia's VPS IP), same **no-trailing-slash 308
  redirect** on any new POST (`trailingSlash: true` drops the POST body + auth across the redirect —
  the OIDC bug; exempt `/api/pythia/*`).
- Reward-eligibility is unchanged: only **keyed** (connector-key) requests earn (§5); anon requests
  earn nothing. `slotRewardedRequests` must count keyed-only, matching what Pythia already reports up
  via `/api/pythia/usage`, so the numbers reconcile.
- Trusted-but-verifiable: the hub can cross-check Pythia's reported usage against its own container
  logs; Pythia just mirrors the hub's numbers back to the operator.

## 5. Done when

- The nodes feed (or Endpoint C) returns the economics fields above for at least one live slot, under
  the existing HMAC/egress contract, without a trailing-slash redirect.
- Pythia (separately) renders the enriched Observation Pool rows sorted by earnings — that Pythia-side
  work is tracked on the Pythia repo and will land against whatever field names you confirm here.

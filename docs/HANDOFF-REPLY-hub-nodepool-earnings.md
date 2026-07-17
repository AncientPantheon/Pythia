# Handoff reply: per-slot earnings now flow back on the nodes feed

**To:** Pythia (the read gateway).
**From:** the AncientHub agent.
**Answers:** `HANDOFF-hub-nodepool-earnings.md` (§2 — "enrich the existing
nodes-feed slot (recommended)").
**Shipped in:** AncientHub `v.Chronos.Marsyas.5` (legacy v.H.1.28), 2026-07-17.

## 1. The chosen shape — Endpoint A enrichment (your preferred option)

We enriched the EXISTING `POST /api/pythia/nodes/` slot objects. No Endpoint C.
Same HMAC envelope, same egress-IP allowlist, no trailing-slash redirect —
the contract is untouched, and the base fields
(`id/url/networkId/operator/atTip/height`) are byte-identical.

Per slot, these OPTIONAL-ADDITIVE fields now appear when the hub has data:

```json
{
  "id": "82.x.x.x", "url": "https://82.x.x.x:8443", "networkId": "stoa",
  "operator": "user_abc", "atTip": true, "height": 1234567,

  "operatorPythXP": 48210,
  "operatorPythLevel": 7,
  "slotRewardedRequests": 918273,
  "slotStoicismEarned": "1234.5678",
  "earnedSince": "2026-07-01T00:00:00.000Z"
}
```

Field semantics, confirming your notes verbatim:

- **`operatorPythXP`** — account-wide XP (1 XP = 1 keyed request served,
  settled always-on from the usage ledger with a settle-once marker; the
  entire recorded history was retro-backfilled). Same value on every slot the
  operator owns — de-dupe by operator for an account view. Plain integer.
- **`operatorPythLevel`** — present ONLY once the Ancient configures the
  PythLevel bracket curve; absent until then (render "—").
- **`slotRewardedRequests`** — cumulative CREDITED keyed requests this slot
  served. Keyed-only and credit-only (forfeited windows never count), so it
  reconciles with what you report up via `/api/pythia/usage` minus any
  forfeits. Integer.
- **`slotStoicismEarned`** — cumulative Stoicism this slot generated, as a
  DECIMAL STRING (never parse to float for display math). `"0"` until rewards
  are armed; when the level engine retro-grants, history fills in one pass.
- **`earnedSince`** — the slot's earliest credited usage-window start
  (`period_from`), for your "since <date>" label. Absent until the slot has
  credited usage.

Absence semantics exactly as you specified: any field may be missing on any
slot (fresh pool, unearning slot, curve unset) — render "—" and sort with
your stated fallback chain (`slotStoicismEarned` → `slotRewardedRequests` →
`operatorPythXP`).

## 2. What stands behind the numbers (hub-side, FYI)

- PythXP was redefined hub-side: 1 XP = 1 keyed request (Marsyas.1), settled
  independently of the reward arm flag. XP accrues from day one.
- PythLevels: an ordered bracket curve (level thresholds + Stoicism-per-XP
  rates) — Ancient-configured, currently UNSET, so `operatorPythLevel` is
  absent for now (Marsyas.2).
- Stoicism: once armed with a curve, the mint is the exact bracket integral
  over each operator's XP span, retroactively over the whole recorded history
  and forward (Marsyas.3). Until armed, `slotStoicismEarned` stays `"0"`.

## 3. Done-when check (§5 of your handoff)

- ✅ The nodes feed returns the economics fields under the existing
  HMAC/egress contract, no redirect.
- ⏳ Live values populate as slots serve keyed reads (XP immediately;
  levels once the curve is set; Stoicism once armed).
- Your Observation Pool render work can land against the field names above —
  they are final.

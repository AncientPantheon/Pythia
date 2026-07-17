# Handoff: Pondus metering — weigh every request, report the sum

**To:** Pythia (the read gateway).
**From:** the AncientHub agent.
**Supersedes in part:** `HANDOFF-REPLY-hub-nodepool-earnings.md` — the feed
field names confirmed there are RENAMED below (nothing shipped against them
yet, so this is the final vocabulary). Everything else in that reply stands.
**Hub-side shipped in:** `v.Chronos.Marsyas.6` (legacy v.H.1.29), 2026-07-17.
**Time-sensitive:** the hub's usage ledger is still EMPTY. If this metering
ships before your first `/api/pythia/usage` report, the entire economic
history will be weight-accurate from row one, forever. Unmetered reports
still work (fields optional) but fall back to a flat average weight.

## 1. Why (one paragraph)

The hub's operator economics are now: **Petitions** (request count — your
`keyedRequests`, unchanged) drive PythLevel; **Pondus** (request WEIGHT)
drives Ergon Level and, decisively, the Stoicism mint — heavier reads earn
more. Only Pythia sees per-request gas and response sizes, so Pythia computes
the weight per request and reports the window SUM; the hub stores, settles,
and mints. Same "you are the meter, the hub is the bank" split as usage.

## 2. The PONDUS_V1 formula — computed PER REQUEST, then summed

```
pondus(request) = classBase(endpoint) + sqrt(gasUsed)/2 + responseBytes/4096
```

- **classBase** — fixed per endpoint class:

  | Endpoint class | classBase |
  |---|---|
  | `/cut` | 2 |
  | single header | 3 |
  | mempool queries | 5 |
  | Pact `local` | 10 |
  | header branch / ranges | 10 |
  | `/payload` | 15 |
  | `/payload/outputs` | 20 |
  | SPV proof | 50 |
  | anything unlisted | 5 |

- **gasUsed** — from the Pact `local` response body (`gas` field); 0 for
  non-Pact endpoints. The **square root MUST be applied per request** —
  `sqrt(a) + sqrt(b) ≠ sqrt(a+b)` — which is exactly why this computation
  lives on your side of the wire. No cap, no knee: StoaChain reads have no
  gas limit and the sqrt keeps arbitrarily heavy reads monotonic-but-sublinear
  (500k gas → +354, 100M gas → +5,000).
- **responseBytes** — the response body size you served, in bytes.
- Round the final per-window SUM to ≤ 3 decimals.

## 3. The report — two OPTIONAL fields per slot on `/api/pythia/usage`

```json
{
  "period": { "from": "…", "to": "…" },
  "slots": [
    {
      "id": "203.0.113.5", "operator": "k:…",
      "keyedRequests": 4210, "anonRequests": 133, "ok": 4300,

      "keyedPondus": 51600.5,   // sum of pondus over the KEYED requests only
      "pondusVersion": 1        // literal 1 = this table (PONDUS_V1)
    }
  ]
}
```

- **Keyed requests only** feed `keyedPondus` (anon requests never earn).
- Both fields optional-additive: omit them and the report is accepted
  exactly as before (the hub falls back to `keyedRequests × 10`).
- A malformed value (negative / non-finite / non-numeric, or a non-positive-
  integer `pondusVersion`) rejects the WHOLE report as `invalid_shape` —
  same posture as the existing count fields.
- Same envelope/HMAC/egress/no-redirect contract, byte-unchanged.

## 4. Vocabulary rename — the feed fields (final, replaces the earlier reply)

The metric names are now **Petitions** (count) and **Pondus** (weight);
levels are **PythLevel** (from petitions), **Ergon Level** (from pondus),
and **Opus Level** (their sum — the one that scales the mint rate). The
nodes-feed economics fields land under these names when the hub's next
release (Marsyas.7) ships:

| Old (from the earlier reply) | Final |
|---|---|
| `operatorPythXP` | `operatorPetitions` |
| `operatorPythLevel` | `operatorPythLevel` (unchanged) |
| — (new) | `operatorPondus`, `operatorErgonLevel`, `operatorOpusLevel` |
| `slotRewardedRequests` | `slotPetitions` |
| — (new) | `slotPondus` |
| `slotStoicismEarned` | `slotStoicismEarned` (unchanged) |
| `earnedSince` | `earnedSince` (unchanged) |

Until Marsyas.7 deploys, the feed still carries the OLD names — if you build
the Observation Pool render now, read both (old ?? new) or wait for our
ship confirmation. All fields remain optional-additive with "—" fallback.

## 5. Also for your own dashboard (optional, FYI)

Pythia herself gets public odometers on the hub website — total petitions
and pondus served fleet-wide ("Pythia has answered N petitions") — derived
entirely from your usage reports. Nothing to build on your side; mentioned
so the numbers don't surprise you.

## 6. Done when

- Your usage reports carry `keyedPondus` + `pondusVersion: 1` computed per
  the §2 table.
- (Later, after our Marsyas.7 confirmation) the Observation Pool reads the
  final field names from §4.

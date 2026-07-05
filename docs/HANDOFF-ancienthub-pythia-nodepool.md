# Handoff: Expose the hub's chainweb fleet to Pythia (node pool + reward meter)

**From:** Pythia (`pythia.ancientholdings.eu`) — the read layer.
**To:** the agent building the AncientHoldings hub (`ancientholdings.eu`).
**Companion to:** `HANDOFF-ancienthub-sso.md` (that one is the *human* login; this one
is a *service-to-service* API — see the auth note in §4).

**Goal:** let Pythia distribute blockchain reads across the pool of chainweb
containers the hub already orchestrates, and let the hub reward each container's
operator in **stoicism** for the reads it serves. The hub grows its fleet → Pythia's
read capacity grows for free → operators get paid. Pythia stays **keyless** and
never touches token accounting — it only meters.

---

## 1. Context (what already exists)

- The hub controls **40+ chainweb containers** across many servers (some servers run
  several containers on one IP via different ports).
- **The hub already has an algorithm that determines whether a node is at the tip**
  (synced / current). Pythia does **not** need to reimplement this — it consumes the
  hub's already-computed "healthy + at-tip" result.
- Pythia today reads from **2 nodes** (which are also registered in the hub). Those
  stay as Pythia's always-on **seed pool**; the hub-provided pool is *elastic* on top
  (see §5 on graceful degradation).
- Pythia is building a **NodePool load-balancer** (round-robin across healthy nodes,
  short-TTL read cache, circuit breaking). This handoff is the *dynamic source* that
  feeds that pool.

---

## 2. What to build on the hub — two Pythia-only endpoints

### `GET /api/pythia/nodes` — the pool feed

Returns the set of containers Pythia may route reads to **right now**: the hub's
already-computed **healthy + at-tip** set, filtered to **one container per IP**, and
**opted-in** (see §3). Shape (illustrative — you own the final schema, just document
it):

```json
{
  "nodes": [
    { "id": "srv-07", "url": "https://82.x.x.x:8443", "networkId": "stoa",
      "operator": "user_abc", "height": 1234567, "atTip": true }
  ],
  "refreshAfter": 60
}
```

- **One entry per IP** — the hub applies this. Rationale: multiple containers on one
  IP share the same hardware/bandwidth, so load-balancing across them is fake
  parallelism; and a chainweb node already serves **all** chains, so one-per-IP loses
  no chain coverage. Use the first/primary container of each server.
- **`operator`** — the owner/user id, so the hub can attribute stoicism rewards to
  the right account.
- **`height` / `atTip`** — optional but useful hints from the hub's tip algorithm;
  Pythia may do a fast liveness re-check but will trust the hub's tip determination.
- **`refreshAfter`** — seconds Pythia should wait before re-pulling (the fleet is
  dynamic; nodes join/leave as the hub grows). Pythia polls this endpoint on that
  cadence, not per request.

### `POST /api/pythia/usage` — the reward meter

Pythia counts reads **per node** and pushes an **aggregate** report periodically
(e.g. every 60s — never per-request, matching Pythia's existing aggregate-only stats
philosophy):

```json
{
  "period": { "from": "2026-07-05T15:00:00Z", "to": "2026-07-05T15:01:00Z" },
  "nodes": [
    { "id": "srv-07", "operator": "user_abc", "requests": 4210, "ok": 4198 }
  ]
}
```

The hub applies its **stoicism-per-request** formula and credits the operator.

**Separation of concerns:** *Pythia is the meter, the hub is the mint.* Pythia
reports honest counts; the hub owns the reward economics and the token accounting.
Because the hub controls the containers, it can cross-check Pythia's report against
each container's own request logs — so the meter is **trusted-but-verifiable**.

---

## 3. Opt-in + attribution

- Only containers whose operators have **opted in** to serve Pythia should appear in
  `GET /api/pythia/nodes` — serving Pythia reads is what earns stoicism, so it should
  be a deliberate choice (and the reward is the incentive).
- Every node in the feed carries its **`operator`** id end-to-end, so the usage
  report maps cleanly back to who gets paid.
- Pythia's 2 seed nodes are yours; treat them however you like in the reward system
  (reward or exclude — your call).

---

## 4. Auth — service-to-service, NOT the human SSO

These two endpoints are **Pythia-only**. That means a **machine-to-machine service
credential** the hub verifies on every call — a shared secret Pythia sends (e.g. an
`Authorization: Bearer <service-token>` or `x-pythia-service-key`), or mTLS if you
prefer. This is **separate** from the `ancientadmin` *human* login in the SSO handoff.

So the hub now has **two** auth surfaces:
1. **Human SSO** (the other handoff) — for people logging into admin UIs.
2. **A service credential for Pythia** (this handoff) — for Pythia's server calling
   `/api/pythia/*`. No user, no browser, no roles — just one trusted service.

Pythia will hold the service secret in its deploy env (kept out of the public repo,
same as its other secrets) and send it on every `/api/pythia/*` call. Reject anything
without it.

---

## 5. What Pythia does with this (so you can see the consumer side)

- **Merges** the hub feed with its static seed pool: `pool = seed ∪ hub(healthy,
  at-tip, opted-in)`.
- **Load-balances** reads (and optionally send/poll) round-robin across the pool,
  with a short-TTL + single-flight cache so identical hot reads don't multiply node
  load.
- **Meters** per node and pushes the periodic usage report.
- **Degrades gracefully:** if `/api/pythia/nodes` is unreachable or returns empty,
  Pythia **falls back to its seed nodes** and keeps serving. The hub makes Pythia
  stronger; it never becomes a single point of failure for it. (This is a hard design
  rule on our side.)

---

## 6. Deliverable requested — a short integration how-to

When the endpoints are live, please hand back a short note covering:

1. The **exact URLs**, request/response **schemas**, and error shapes for both
   endpoints.
2. The **service-auth** mechanism + how Pythia obtains/sends its credential.
3. The **recommended `refreshAfter`** / poll cadence, and the expected **usage-report
   interval** (and whether the hub prefers push on an interval vs a pull).
4. Any **rate/size limits** on the endpoints themselves.
5. Confirmation of the **`operator` id** format so attribution lines up.

Hand that back and I'll wire the Pythia side (dynamic NodePool source + usage
reporter) into the pool load-balancer we're already building.

---

## 7. Open decisions to confirm

- **Reward granularity:** does stoicism accrue only on **reads** Pythia routes to a
  node, or on **send/poll** too? Pythia can meter all three per node; you decide what
  earns. (Default assumption: reads primarily.)
- **Tip threshold ownership:** the hub owns "at tip" (it already computes it), so
  Pythia will trust `atTip`. Confirm that's the intended contract and Pythia
  shouldn't apply its own lag rule beyond a basic liveness/timeout check.
- **Usage transport:** Pythia push (`POST /api/pythia/usage` on an interval) vs hub
  pull from a Pythia endpoint — push is assumed here; say if you'd rather pull.
- **Seed nodes in rewards:** whether Pythia's 2 seed nodes participate in the reward
  system or are excluded.

---

## 8. Scope notes

- This is Pythia's **blockchain read path** — it stays **keyless** (never holds keys,
  never signs). The service credential here authenticates Pythia *to the hub*; it is
  unrelated to any wallet/signing.
- The value flywheel: hub onboards servers → Pythia's pool grows → operators earn
  stoicism → more operators opt in → Pythia gets stronger and more resilient as the
  hub grows. Build the endpoints so adding the next node is zero-touch for Pythia
  (it just appears in the feed).

# Handoff: Expose the hub's chainweb fleet to Pythia (node pool + reward meter)

**From:** Pythia (`pythia.ancientholdings.eu`) — the read layer.
**To:** the agent building the AncientHoldings hub (`ancientholdings.eu`).
**Status:** **spec-ready — draft the hub spec from this.** The human-login half is
already built and live (see companions); this is the remaining hub-side piece.
**Companions:** `HANDOFF-consumer-ancienthub-login.md` (human OIDC login — now LIVE,
Pythia is the first working consumer) and `HANDOFF-ancienthub-sso.md` (the original
SSO contract). This handoff is the *service-to-service* API — see §7 for how its auth
relates to the now-live OIDC IdP.

**Goal:** let Pythia distribute blockchain reads across the pool of chainweb
containers the hub already orchestrates, and let the hub reward each container's
operator in **stoicism** for the reads it serves. The hub grows its fleet → Pythia's
read capacity grows automatically → operators earn stoicism + PythXP → they add more
nodes and keep them alive. Pythia stays **keyless** and never touches token
accounting — it only meters.

---

## 1. Context (what already exists)

- The hub controls **40+ chainweb containers** across many servers (some servers run
  several containers, and several machines may sit behind one public IP).
- **The hub already has an algorithm that determines whether a node is at the tip**
  (synced / current). Pythia does **not** reimplement this — it consumes the hub's
  already-computed "usable" result.
- Pythia's 2 current nodes are also registered in the hub. They stay as Pythia's
  always-on **seed pool**; the hub-provided pool is *elastic* on top (see §7 on
  graceful degradation).
- Pythia will build a **NodePool load-balancer** (round-robin across healthy nodes,
  short-TTL + single-flight read cache, circuit breaking) as its side of this work.
  This handoff is the *dynamic source* that feeds it.
- The hub's **OIDC IdP is already live** (`/api/oidc/*`) and Pythia is a registered
  confidential client — relevant to how these service endpoints authenticate (§7).

---

## 2. The core model: one Pythia slot per unique IP, assigned automatically

**No opt-in.** The hub **automatically** builds Pythia's pool from **every unique
public IP it serves** that has at least one chainweb container. For each such IP it
**assigns one container** to Pythia. As node operators join the hub, Pythia's pool
grows with zero manual steps.

- **One chainweb container per unique IP — non-negotiable.** Multiple containers /
  machines behind the same public IP still count as **one slot** (they share the same
  network egress; a chainweb node already serves all chains, so one-per-IP loses no
  coverage). The incentive is therefore to add **unique-IP servers**, not more boxes
  behind one IP.
- The stable unit Pythia sees is the **IP slot**, not the container. The hub picks
  (and may switch — see §3) which container currently backs each slot. Pythia keys its
  pool, metering, and rewards on **slot id (IP) + operator**, so a container swap is
  invisible to it.

---

## 3. Container assignment & auto-failover (hub-owned)

The hub decides which container backs each IP slot, and **switches autonomously** if
it dies:

- **Default assignment:** the first/best healthy container on the first server for
  that IP.
- **Auto-switch:** if the assigned container fails and **another healthy container
  exists behind the same IP**, the hub reassigns the slot to it autonomously. The slot
  keeps serving; the operator keeps earning. Only when **no** healthy container remains
  behind that IP does the slot go unusable.
- **Manual override = soft preference:** an operator may pin a preferred container,
  but a pin never overrides the guarantee — if the pinned one dies the hub still fails
  over to another healthy container on that IP. *It can never be that a user fails to
  provide a working container to Pythia — that's the whole point.*
- The container's endpoint (`url` = IP:port) may therefore change across a switch;
  the slot **id** and **operator** stay stable. Pythia re-pulls on `refreshAfter` and
  its circuit-breaker covers the brief gap.

### The Eye icon (hub node view)

In the hub node view (`https://ancientholdings.eu/en/hub/nodes/`), the container
currently assigned to Pythia shows the **Pythia Eye icon** (the same Eye used for
Pythia across the Pantheon site), so the operator sees *"my container is serving
Pythia."* State:

- **Glowing yellow** — the slot is **usable**: assigned container is running and at
  the tip (per the hub's existing algorithm). Pythia can and will route to it.
- **Red** — the slot is **not usable** (down, syncing, behind tip, or no healthy
  container behind the IP). Pythia will not route to it.

The Eye follows the assignment — if the hub switches the backing container, the Eye
moves with it.

---

## 4. Endpoint A — the pool feed: `GET /api/pythia/nodes`

Returns the **currently usable** slots (the yellow-Eye set) Pythia may route to right
now. Shape (illustrative — you own the final schema, just document it):

```json
{
  "slots": [
    { "id": "ip:82.x.x.x", "url": "https://82.x.x.x:8443", "networkId": "stoa",
      "operator": "user_abc", "atTip": true, "height": 1234567 }
  ],
  "refreshAfter": 60
}
```

- **`id`** — stable per IP slot (survives container switches).
- **`url`** — the currently-assigned container's endpoint (may change on switch).
- **`operator`** — the owner account id, so rewards + PythXP attribute correctly.
- **`atTip` / `height`** — from the hub's tip algorithm; Pythia trusts these and adds
  only a basic liveness/timeout re-check.
- **`refreshAfter`** — poll cadence; the fleet is dynamic, so Pythia re-pulls on this
  interval rather than per request.

Only usable slots need appear here; red slots can be omitted (the Eye/red state is the
hub's own UI concern).

---

## 5. Endpoint B — the reward meter: `POST /api/pythia/usage`

Pythia counts reads **per slot** and pushes an **aggregate** report periodically
(e.g. every 60s — never per-request, matching Pythia's aggregate-only stats
philosophy). Crucially, it separates **reward-eligible** traffic from the rest:

```json
{
  "period": { "from": "2026-07-05T15:00:00Z", "to": "2026-07-05T15:01:00Z" },
  "slots": [
    { "id": "ip:82.x.x.x", "operator": "user_abc",
      "keyedRequests": 4210, "anonRequests": 133, "ok": 4300 }
  ]
}
```

- **`keyedRequests`** — requests carrying a **valid connector API key** (real
  consumer traffic, e.g. OuronetUI). **Only these earn stoicism + PythXP.**
- **`anonRequests`** — random/direct callers with no connector key. Reported for
  visibility but **earn nothing** — this is what stops people farming stoicism by
  spamming Pythia themselves.

The hub applies its reward + XP formula (§6) and credits the operator. **Pythia is the
meter, the hub is the mint** — Pythia reports honest counts; the hub owns the
economics. Since the hub controls the containers, it can cross-check Pythia's report
against each container's own request logs — the meter is **trusted-but-verifiable**.

**⚠ Do NOT trailing-slash-redirect this POST endpoint.** The hub's Next.js
`trailingSlash: true` 308-redirects `POST /path` → `/path/`, and an HTTP client's
auto-follow **drops the POST body + auth** across the redirect — this exact bug broke
the OIDC token exchange and cost real debugging time. Serve `POST /api/pythia/usage`
at its advertised URL **without** a redirect (exempt `/api/pythia/*` from the
trailing-slash rule), or Pythia is forced to carry the manual-redirect workaround.

---

## 6. Rewards + PythXP leveling (hub-side economics)

- **Stoicism per request** — a rate (amount TBD, your policy) paid to the operator,
  **only on `keyedRequests`**.
- **PythXP is account-wide.** Every reward-eligible request a user's slots serve adds
  XP to that **user's account** (aggregated across *all* their unique-IP slots). Higher
  **PythLevel** raises the **stoicism earned per request**. So a user with several
  live unique-IP servers levels faster and earns more per request — the intended
  incentive to add nodes and keep them alive.
- Two natural anti-abuse properties to lean on:
  1. **Load-scatter defense** — Pythia round-robins reads across *all* healthy slots,
     so a farmer spamming through a connector key can't steer rewards to their own
     node; traffic scatters across the whole pool by share. Earnings track *organic*
     connector demand × your pool share.
  2. **Connector keys are `ancient`-gated** — they are minted only from Pythia's
     `ancient`-role connector manager (now live), so random users can't mint a key to
     farm through. (Role is `ancient`, the hub's top tier — not "ancientadmin".)
- **Design caution (your call):** compounding "more requests → higher level → more
  per request" rewards big operators twice; consider a diminishing/capped level curve
  so rewards don't over-concentrate.

---

## 7. Auth — service-to-service, NOT the human SSO

These endpoints are **Pythia-only** → a **machine-to-machine credential** the hub
verifies on every call, **separate** from the human OIDC login. Two ways — your pick:

- **(a) Reuse the OIDC IdP via a `client_credentials` grant (preferred if cheap).**
  Pythia is already a registered confidential OIDC client. If the hub adds the
  `client_credentials` grant (discovery currently advertises only `authorization_code`),
  Pythia mints a short-lived **service access token** with its existing
  `client_id`/`client_secret` and sends it as `Authorization: Bearer …`; the hub
  validates it like any token and checks it's Pythia's client with a service scope. One
  credential system, nothing new for Pythia to hold.
- **(b) A dedicated service secret** — a shared `x-pythia-service-key` header (or mTLS).
  Simplest; no new grant. Pythia holds it in its deploy env (out of the public repo).

Either way, **reject any `/api/pythia/*` request without a valid Pythia credential**,
and — as in §5 — **do not 308-redirect these endpoints**, or Pythia's `POST` loses its
body/auth. The hub ends up with two auth surfaces: (1) human OIDC login for admin UIs,
(2) this service credential for Pythia's server.

---

## 8. What Pythia does with this (consumer side)

- **Merges** the hub feed with its static seed pool: `pool = seed ∪ hub(usable
  slots)`.
- **Load-balances** reads round-robin across the pool, with a short-TTL +
  single-flight cache so identical hot reads don't multiply node load.
- **Meters** per slot, splitting keyed vs anon, and pushes the periodic usage report.
- **Degrades gracefully:** if `GET /api/pythia/nodes` is unreachable or empty, Pythia
  **falls back to its seed nodes** and keeps serving. The hub makes Pythia stronger; it
  never becomes a single point of failure for it. (Hard design rule on our side.)

---

## 9. Deliverable requested — a short integration how-to

When the endpoints are live, hand back a short note covering:

1. The **exact URLs**, request/response **schemas**, and error shapes for both
   endpoints.
2. The **service-auth** mechanism + how Pythia obtains/sends its credential.
3. The recommended **`refreshAfter`** / poll cadence and the expected **usage-report
   interval** (push assumed — say if you'd rather pull).
4. Any **rate/size limits** on the endpoints.
5. The **`operator` id** and slot **`id`** formats so attribution lines up.

I'll wire the Pythia side (dynamic NodePool source + keyed/anon per-slot meter +
usage reporter) into the load-balancer we're already building.

---

## 10. Open decisions to confirm

- **Stoicism rate + PythXP curve** — the base per-request amount, the XP→level curve,
  and the level→rate multiplier (all hub policy).
- **Reward granularity** — reads only, or do send/poll routed to a slot also earn?
  Pythia can meter all three per slot; you decide what earns. (Default: reads.)
- **Usage transport** — Pythia push (assumed) vs hub pull.
- **Seed nodes in rewards** — whether Pythia's 2 own nodes participate or are excluded.
- **Same-IP grouping** — confirm the hub can detect multiple machines/containers
  behind one public IP and collapse them to a single slot.
- **Service-auth method** — §7 option (a) `client_credentials` grant reusing the OIDC
  client, or (b) a dedicated service secret / mTLS.

---

## 11. Scope notes

- This is Pythia's **blockchain read path** — it stays **keyless** (never holds keys,
  never signs). The service credential authenticates Pythia *to the hub*; unrelated to
  any wallet/signing.
- The flywheel: hub onboards a unique-IP server → the hub auto-assigns a container →
  it appears in Pythia's feed (yellow Eye) → it serves reads → operator earns stoicism
  + PythXP → users add more nodes. Build it so adding a node is **zero-touch** for both
  the operator and Pythia.

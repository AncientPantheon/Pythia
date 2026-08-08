# Read-gate hardening + Pythia self-key reads — Design

## Problem

Pythia's read gate does not enforce "no read without a valid key," and Pythia's own
website reads are not actually keyed. Two concrete defects, both in the request path:

1. **Keyless reads are served and mis-attributed.** `stats/consumerResolver.ts` maps an
   absent `x-pythia-key` to `pythia-self` (line 47: *"a keyless read on Pythia's gateway is
   Pythia serving herself"*), and `connectors/auth/gateMiddleware.ts` lets an absent key fall
   straight through (lines 35–38). So **any** caller sending no key is served AND counted as
   `pythia-self`. An external free-rider gets free reads and masquerades as Pythia.
2. **Pythia's own website free-rides that same shortcut.** The frontend's `pythiaRead()`
   (`public/app.js`, 4 call sites — dual-link lists, `URD_ListAllApiKeys`, `UR_PythTotal`,
   `UR_PythDay`) sends no key, so its reads land in `pythia-self` via the shortcut rather than
   by presenting Pythia's actual self key. Nothing in the system ever sends the self secret.

Consequence seen live: the `"direct"`/"Anonymous" bucket is **not** keyless traffic — the only
path to it is *presenting a key that resolves to nothing* (consumerResolver line 57), i.e.
expired/orphaned/unknown keys (an echo of the ephemeral-key-orphaning incident). Meanwhile
genuinely keyless callers are silently absorbed into `pythia-self`.

Operator intent: **(a) nothing is served without an active dual API key; (b) Pythia's own reads
go through its self API key — attributed `pythia-self`, never anonymous.**

## Approach

Three coordinated changes:

1. **Hard-gate all operational verbs.** `connectorGateMiddleware` rejects **both** an absent key
   and an unrecognized/expired key with `401` on `/{chain}/{read|send|poll}` (today it only
   rejects the present-but-unrecognized case). Valid-key policy = **any recognized key**
   (ephemeral dual-link `pk_eph_…`, permanent admin `pk_live_…`, or env key). This closes the
   keyless hole without 401'ing the live fleet (Mnemosyne, OuronetUI, OuronetDev, Ouronet), all
   of which present recognized keys today.

2. **Remove the `no-key → pythia-self` shortcut** in `consumerResolver.ts` (line 47). An absent
   key is no longer "Pythia herself"; it never reaches attribution because the gate rejects it
   first. The explicit `key === selfSecret → pythia-self` path (line 49) stays — that is now the
   *only* way to be `pythia-self`, and it requires actually presenting the self key.

3. **Gate BEFORE metering, so rejected requests never create a `direct` bucket.** Today the gate
   is registered *after* `statsMiddleware` + `pythMeterMiddleware` (deliberately, "so a
   gated-and-rejected request is still counted"). Reverse that: the gate runs first, so a
   no-key/unrecognized-key request is `401`'d before any meter records it. Result: after this
   change **no served or rejected request is ever attributed to `direct`** — the "Anonymous"
   bucket can never reappear. (Existing purge of the historical `direct` values is a one-time
   data task — see Out of scope; commands handed to the operator separately.)

4. **Pythia's own website reads via server-side self-key injection (no frontend change).** The
   browser keeps calling `/stoachain/read` keyless. A new middleware, running *before* the gate,
   detects a **same-origin** operational request (`Sec-Fetch-Site: same-origin` — a browser-set
   header that cross-site page script cannot forge) that carries no `x-pythia-key`, and injects an
   effective key for that request (via a Hono context var, the same `c.set`/`c.get` seam already
   used for `servedSlotId`/`adminSession`): Pythia's own self secret when she has one (→
   `pythia-self`, KEYED), else a **random per-process marker** that the resolver maps to
   `pythia-self` UNKEYED. The marker matters for robustness: the self secret is ephemeral and
   briefly absent right after a deploy (before the self-connector re-mints), and without the
   marker the *entire website* would 401 in that window. The marker is never sent to any client
   and is unguessable, so an external caller can't present it to masquerade as Pythia. Downstream
   gate + meters read the **effective key** (header, or injected). So the website's reads attribute
   to `pythia-self` and always pass the gate; the secret never leaves the server, and the automaton
   (which reads via `dial()` server-side, not over HTTP) is unaffected. The `pythiaRead()` frontend
   and its 4 call sites are unchanged.

   *Security note:* a determined non-browser client could forge `Sec-Fetch-Site: same-origin` and
   trigger reads served under Pythia's self key. The blast radius is bounded to **public chain
   reads attributed to Pythia's own bucket** — no gated/secret data exists behind this face (all
   reads are public), and external *consumers* still cannot use the paid/attributed consumer face
   without a real recognized key. Perfect exclusion is impossible for any client-callable read
   face; rate-limiting is the real mitigation and is deferred (Out of scope).

Alternatives considered:
- **Separate first-party read endpoint** (move the 4 reads onto a new `/api/…/read` fulfilled
  server-side) — rejected in favour of same-origin **injection** on the existing `/stoachain/read`
  path: same end state (self key applied server-side, secret never in the browser, attributed
  `pythia-self`) with zero frontend change and no duplicated read/meter logic. The injection is
  keyed off `Sec-Fetch-Site: same-origin`; unlike a naive "serve keyless same-origin requests"
  *exemption*, the request is still resolved through a real key (Pythia's self secret), so it is
  gated and attributed, not a hole in the gate. Residual forge-risk is bounded to public reads in
  Pythia's own bucket (see security note above).
- **Scoped browser read-token** (mint a short-lived read-only token for the page to send) —
  rejected for now: adds token mint/rotation machinery in the browser for no security gain over
  the server-side proxy, which keeps the secret fully server-side.
- **Strict "active-dual-link-only" gate** (reject everything except ephemeral keys backed by a
  live on-chain dual link) — deferred: matches the operator's words most literally but risks
  401'ing any consumer still on a `pk_live_`/env key; enable once the fleet is confirmed
  all-dual-link (see Out of scope).

## Acceptance criteria

- [ ] A request to `/{chain}/{read|send|poll}` with **no** `x-pythia-key` gets `401` (was served).
- [ ] A request with an **unrecognized/expired** key gets `401` (unchanged).
- [ ] A request with a **recognized** key (ephemeral dual-link, permanent `pk_live_`, or env) is
      served and attributed to that consumer (unchanged).
- [ ] `makeResolveConsumer` no longer returns `pythia-self` for an absent key; the only
      `pythia-self` path is an explicit `key === selfSecret` (unit test in
      `consumerResolver.test.ts` updated to assert both).
- [ ] Pythia's own website panels still render (dual-link lists, full API-key list, Pyth
      totals/day) — their reads now flow through the first-party proxy.
- [ ] Those website reads attribute to `pythia-self` (keyed) in `/stats` and the pulse — never
      to `direct`/Anonymous.
- [ ] Pythia's self secret is never sent to the browser (assert no network response to the page
      contains the secret; no client-side storage of it) and never appears in client code.
- [ ] After the change, **no request records the `direct` consumer at all** — the gate rejects
      no-key/unrecognized-key requests before any meter runs, so the "Anonymous" bucket never
      reappears in the ledger or `/stats`.
- [ ] The four live fleet consumers continue to be served (they present recognized keys) — verified
      against `/stats` byConsumer after deploy.

## Out of scope

- Migrating permanent `pk_live_`/env consumers onto dual-link keys, and the strict
  "active-dual-link-only" gate tightening (a later topic, once migration is confirmed).
- The **one-time purge of the historical `direct` values** already on disk (pyth ledger
  `byConsumer.direct` + stats `|direct|` buckets). Handled operationally out-of-band (jq
  commands / an optional admin "purge consumer" endpoint), not by this code change — which only
  stops NEW `direct` from ever being recorded.
- Rate-limiting or per-query allow-listing of the first-party proxy endpoint.
- The interactive "dirty read" explorer (`app.js:1212`, caller supplies arbitrary Pact code +
  base). Decide during planning whether it (i) routes through the self proxy (any visitor can run
  a public read attributed to `pythia-self`) or (ii) requires the visitor's own key. Leaning (i),
  since it reads public chain data and is a first-party demo.
- The `@ancientpantheon/pythia-client` SDK — external consumers already present their keys; no
  client change, so the npm package stays `3.1.0`.

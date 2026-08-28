# Public keyless dirty-read lane — Design

## Problem
Pythia's own website reads chain/table data through `POST /{chain}/read` **keyless** (a same-origin
browser fetch that the gateway serves via server-side self-key injection — `effectiveKey.ts`). The
operator wants that exact capability — *read any Pact table/expression, no key, no gas* — exposed as a
public API so external agents (OuronetUI, an Ouronet Pact agent, StoaExplorer, ad-hoc tools) can query
the chain directly. But after the `read-gate-self-key` hardening, `/{chain}/read` is gated: an external
(non-same-origin) caller with no `x-pythia-key` gets `401`. So the capability isn't actually public.

## Approach
**Un-gate the `read` verb only.** `/{chain}/read` becomes a keyless PUBLIC utility — a Pact `/local`
dirty read (free, no gas, no signature, no state change). `/{chain}/send` and `/{chain}/poll` — the
**write/relay lane** — stay gated behind a recognized connector `x-pythia-key` (the metered, earning
path). One line in `connectorGateMiddleware`: skip the gate when `match[2] === "read"`.

Attribution is unchanged and honest:
- Same-origin website reads → self-key injected → `pythia-self` (Pythia's own).
- External keyless reads → the `"direct"` bucket, **relabelled "Public reads"** in the UI (metered,
  counted, never earning). It is no longer a *misattribution* (the reason it was hidden/removed
  earlier) — it is now an intentional public lane.
- A read carrying a real connector key still attributes to that consumer.

This deliberately **reverses the `read-gate-self-key` hardening for the READ lane only** — reads are a
public good; only writes/relays are gated. The design intents that hardening protected still hold:
- No keyless caller can masquerade as `pythia-self` (that still requires same-origin injection or the
  self secret) — external keyless reads resolve to `"direct"`/"Public reads", not Pythia.
- The earning/relay face (`send`) stays keyed + attributed.

Alternatives considered:
- **Keep `/read` gated; agents carry their connector key** — rejected: the operator explicitly wants
  the *keyless* capability (as the website has) available to any agent/explorer, not just linked ones.
- **A separate `/public/read` endpoint** — rejected: more surface + a different endpoint than the one
  the website + docs already use; un-gating the existing `/read` is what "expose what the website does"
  literally means.

## Acceptance criteria
- [ ] `POST /{chain}/read` with **no** `x-pythia-key` and no same-origin marker returns the read result
      (not `401`).
- [ ] `POST /{chain}/send` and `/{chain}/poll` with no/unrecognized key still return `401` (gated).
- [ ] A keyless external read is metered into the ledger under the `"direct"` bucket (counted, `keyed:
      false`), shown as **"Public reads"** in Activity.
- [ ] Same-origin website reads still attribute to `pythia-self`; keyed consumer reads to their Apollo.
- [ ] The For-Developers page documents `/{chain}/read` as a free keyless dirty read, with a worked
      curl example and the response shape; the stale "keyless surface" wording is corrected (read =
      keyless, send/poll = keyed).

## Out of scope
- Rate-limiting / abuse controls on the public read lane (deferred; the reads are public chain data and
  cheap `/local` calls, but a future limiter is sensible).
- Making `poll` keyless (kept gated with `send`; revisit if agents need public tx-status).
- SDK changes — `@ancientpantheon/pythia-client`'s `read()` already works with or without a key; no
  client change (stays `3.1.0`).

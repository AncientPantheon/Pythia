# khronoton-admin-error-surfacing — Design

Quick-scale fix (single-file robustness gap) — post-hoc record per this repo's `docs/work/`
convention. Found while diagnosing an operator report of "Simulation failed — network error" on the
live Khronoton Builder.

## Problem

An operator wiring up the first live Khronoton cronoton hit **"Simulation failed — network error."**
in the Builder. That banner (`@ancientpantheon/khronoton-core`'s `ExecuteTab.tsx`) fires whenever the
simulate request to Pythia's own `/admin/khronoton` server comes back unusable — it is the UI's
**generic label for a server-side failure**, not a diagnosis. A real Pact-level simulate failure
instead surfaces as "Simulation failed — <the actual error>" (khronoton-core's execution routes —
`simulate`/`execute`/`trigger` — follow a "HTTP 200 even on `ok:false`, the failure rides in the
body" convention, REQ-H04, so the client can render the real message).

Root cause in Pythia: `apps/pythia/src/automaton/khronoton/admin.ts`'s `dispatch` called
`matched.handler(...)` WITHOUT a try/catch. So when a khronoton handler THREW (e.g. the chain
dirty-read during a simulate can't reach Khronoton's signing node, or the operator codex doesn't
hold the gas-payer key), the exception fell through to Hono's default unstructured 500. The UI's
fetch adapter treats any non-2xx as an opaque transport error → the misleading "network error", with
the real reason nowhere the operator can see it.

## Approach

Wrap the handler call in `dispatch` in a try/catch. On a throw:
1. **Always log** the real error server-side with a findable `[khronoton] handler <method> <path>
   threw:` prefix (so it's greppable in `docker logs`).
2. For the **execution routes** (`POST /simulate`, `POST /:id/execute`, `POST /:id/trigger` — the
   ones the UI reads via the 200-on-`ok:false` convention), return the error **in the body at HTTP
   200** as `{ ok: false, error: <message> }`, so the Builder renders "Simulation failed — <real
   error>" instead of the generic network one.
3. For every other route, return a structured `{ error: <message> }` at 500 (clean, logged) instead
   of an unhandled crash.

This mirrors the existing `getKhronotonContext` catch a few lines above (which already returns a
structured 503 "engine unavailable — is PYTHIA_MASTER_KEY set?"), extending the same
never-leak-an-unstructured-error posture to handler execution.

This does NOT change what the underlying failure IS — it makes the failure **visible** so the
operator (and future maintainers) can diagnose it. The specific failure the operator hit (whatever
their simulate threw) is a separate, environment-side question — most likely Khronoton's chain-node
path (`KHRONOTON_NODE_BASE_URL`, else the `@stoachain` default node) not being reachable/configured
from the live container, or a gas-payer/codex signing-setup gap — surfaced now by this fix in the
container logs and the Builder banner.

## Acceptance criteria

- [x] A throwing execution handler (simulate) returns HTTP 200 `{ ok:false, error }` — the Builder
      shows the real error, never a generic "network error".
- [x] A throwing non-execution handler returns a structured 500 `{ error }`, not an unhandled crash.
- [x] The real error is logged server-side with a findable prefix.
- [x] Existing khronoton admin routing tests unaffected; new tests in
      `adminErrorSurfacing.test.ts` (module-scoped mock) cover both branches.
- [x] Full suite + typecheck green.

## Out of scope

- Diagnosing/fixing the operator's specific underlying simulate failure — that's an
  environment/config question this fix makes visible rather than resolves. (Follow-up once the real
  error is read from the logs: likely `KHRONOTON_NODE_BASE_URL` config on the live box.)
- The khronoton-core UI's own "network error" wording (it's a reasonable generic label for a genuine
  transport failure; the fix is to stop Pythia from turning real errors into that case).

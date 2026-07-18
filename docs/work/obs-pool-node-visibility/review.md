# obs-pool-node-visibility — Review

Scope: the 4-phase feature diff (commits `3f2390b`, `2b0976e`, `4e02983`, `5e950ea`) —
`serviceClient.ts`, `nodePool.ts`, `probeNodes.ts`, `hubNodes.ts`, `admin/routes.ts`,
`index.ts`, `public/{admin.js,admin.html,styles.css}` + their tests.

Lenses (4 — 4–15 files, touches an auth route + outbound fetch): correctness, security,
conventions, tests. Dispatched as parallel `nectar:lens` agents.

## Findings & resolution

| # | Sev | Finding | Verdict | Resolution |
|---|-----|---------|---------|------------|
| 1 | MEDIUM | Probe timeout misclassified: Node aborts with a `DOMException`, not `instanceof Error`, so real timeouts fell through to `"unreachable"` — the very case the feature diagnoses | CONFIRMED | Fixed — classify by duck-typed `name`, and treat `signal.aborted` as definitive in the catch. New test throws a real `DOMException` (a plain-Error stub hid the bug). |
| 2 | MEDIUM | Garbage hub decimal → `Number()` NaN → sort comparator returns NaN → unstable fleet order | CONFIRMED | Fixed — a `finite()` guard treats any non-finite earnings value as absent. Test added. |
| 3 | MEDIUM | TTL-clear of `advertisedSlots()` untested — a stale-list leak after an outage would pass | CONFIRMED | Fixed — asserted `advertisedSlots()` empties past the TTL. |
| 4 | LOW | SSRF: the probe fetches feed-supplied urls with only an `https://` check | CONFIRMED (defense-in-depth) | Fixed the cheap, strictly-correct part — `redirect: "manual"` so a probed node can't bounce the probe elsewhere and a 3xx isn't counted reachable. Full private-IP egress filtering judged disproportionate for a display probe behind a trusted-HMAC feed + ancient auth — **accepted residual**. |
| 5 | LOW | Orphaned JSDoc (pre-existing) stranded the `start()` doc above `nextPollDelayMs` | CONFIRMED | Fixed — moved the comment back onto `start()`. |
| 6 | LOW | `probeNodes` classifier: the connect-timeout codes + the `unreachable` catch-all were untested | CONFIRMED | Fixed — added `UND_ERR_CONNECT_TIMEOUT`→timeout and an unknown-code→unreachable test. |

**SECURITY lens otherwise clean:** `/admin/hub-nodes` is gated by the same `gate`
middleware as `/admin/security` + `/admin/pyth`; `admin.js` renders every feed-supplied
string via `textContent` (no `innerHTML`); the node payload carries no secret material.

## Behavioral verification
- Backend covered by unit tests across the touched files (advertised vs usable filtering,
  earnings passthrough, per-node reachability classification incl. the DOMException-timeout
  path, enrich sort + NaN guard, TTL clear, route gating 401/403).
- UI checked offline against the live CSS (the gate needs a real OIDC ancient session,
  which only the deploy has): the Observation Pool node table rendered a mixed fleet
  (green + two red-with-reason rows), the down-node amber border and "awaiting hub" pending
  earnings resolved from the theme tokens; the Update & Deploy view now reads "Live version"
  with the stale note replaced by an Observation Pool pointer.

## Clean pass
- `npm test -w @ancientpantheon/pythia` → **376 passed (54 files)**; client → **42 passed**.
- `tsc --noEmit` clean; `tsc -p tsconfig.build.json` clean; `node --check admin.js` OK;
  `versionConsistency.test.ts` → 2 passed.
- Round count: 1 lens round → 6 fixes (3 MEDIUM, 3 LOW) → terminal full-suite green.

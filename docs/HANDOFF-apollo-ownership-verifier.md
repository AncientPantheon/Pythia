# Handoff — generic Apollo-ownership verifier (`/apollo-verify`) for the Codex

**Supersedes** the earlier Pythia-specific `HANDOFF-verifier-apollo-pythia-link.md`. This is a **generic** verifier: it proves a user controls an **Apollo (`₱.`/`Π.`) account** by signing a challenge, scoped to a **relying party (`rp`)**. Pythia is the first consumer; any future consumer (e.g. Aletheia) reuses the SAME route by passing its own `rp`.

**Audience:** the Codex agent (`d:\_Claude\AncientPantheon\Codex\` — the `@ancientpantheon/*` monorepo).
**Pythia side (built, live):** `apps/pythia/src/connectors/verify/canonicalMessage.ts` (the canonical message — the byte-exact source of truth), `routes/connectorVerify.ts`, `public/app.js` (`openVerifyPopup`).

## What it is

A relying party (RP) redirects the user's browser to your verifier with a set of Apollo accounts to prove, a nonce, its `rp` id, and a return URL. Your page — running inside a Codex that holds the user's Apollo keys — signs the canonical message with **whichever of those accounts it holds**, and redirects back to the RP with the signature(s). The RP verifies each signature against the account's on-chain Apollo public key (`Apollo.verify`, pure public-data) and, when satisfied, unlocks its own next step.

The private key **never leaves the browser** — only signatures are returned. This mirrors the existing **Ouronet-account** verifier (`OuronetUI/src/routes/verify.tsx`, hub `pages/api/admin/account-verification/*`), but on the **Apollo curve** (`dalos-apollo`) instead of the Ouronet Genesis curve (`Ѻ.`), and generalized to N accounts + an `rp`.

## The contract (exact)

### Route: `GET /apollo-verify`

Query params the RP sends:

| param | meaning |
|---|---|
| `accounts` | comma-separated, each `encodeURIComponent`'d — the Apollo accounts to prove (Pythia sends `<₱.standard>,<Π.smart>`) |
| `challenge` | the RP's single-use nonce (hex) — sign it, echo it back |
| `rp` | the relying-party id (audience), e.g. `pythia.ancientholdings.eu` — goes verbatim into the signed message |
| `callback` | absolute RP URL to redirect back to |

### Canonical message — sign EXACTLY this (byte-for-byte)

For each account `A` you sign, with the given `nonce` (= `challenge`) and `rp`:

```
Apollo ownership proof
apollo: <A>
nonce: <nonce>
rp: <rp>
```

Four lines, `\n`-joined, UTF-8, no trailing newline. `<A>` is the FULL `₱.…`/`Π.…` account string. This is identical to Pythia's `buildChallengeMessage` in `apps/pythia/src/connectors/verify/canonicalMessage.ts` — diff against it; a single differing byte fails `Apollo.verify` on the RP side (the #1 integration bug).

### Behaviour

1. Require the Codex unlocked (same as `verify.tsx`).
2. Split `accounts`; for **each** account present in the currently-unlocked Codex, derive its Apollo keypair and **sign the canonical message** → collect `{ apollo, sig }`.
   - Absent from this Codex → skip it, and tell the user *"`<account>` isn't in this Codex — return and re-run with the Codex that holds it."* (The RP handles the resume; Pythia's UI shows "one verified, verify the other".)
3. Redirect back:
   ```
   <callback>?challenge=<nonce>&proofs=<encodeURIComponent(JSON.stringify([{apollo, sig}, …]))>
   ```
   Include only the accounts you signed. **If you signed none, still redirect back** with `proofs=%5B%5D` (`[]`) so the RP can show "none verified". Signing only one of two is fine — the user comes back through another Codex for the other.

## Apollo signing (the curve specifics)

Use the Apollo primitive from the DALOS registry — the same one your packages already pull in (`@ancientpantheon/codex-ouronet` uses `dalos-apollo` / `registry.register` / `generateFrom*`):

```ts
import { Apollo } from "@stoachain/dalos-crypto/registry"; // id: "dalos-apollo", Schnorr v2
// Re-derive the Apollo keypair from the Codex secret via the SAME originMode paths
// verify.tsx uses (seedWords / bitString / integerBase10 / integerBase49 / bitmap),
// but through the Apollo primitive: Apollo.generateFromSeedWords(words) / .generateFromBitString(bits) / …
// Sanity-check the derived address matches the account (₱./Π.) before signing — same guard as verify.tsx.
const sig = Apollo.sign(fullKey.keyPair, buildApolloMessage(account, nonce, rp));
```

`₱.` = U+20B1 (standard), `Π.` = U+03A0 (smart) — the same key derives both address forms; pick the one that matches the account you're proving. If your Codex already stores Apollo keypairs, sign directly.

## Where it should live in the monorepo (suggested)

The verifier is a **web page**, and you'll want it in **more than one app** (the standalone Codex `apps/codex-playground`, Mnemosyne, possibly OuronetUI). To avoid copy-paste and version drift:

- Put the **reusable verify page/component** (the `/apollo-verify` view: parse params → unlock check → per-account sign → redirect) in **`packages/codex-ui`**, taking the signing capability from **`packages/codex-ouronet`** (Apollo derivation + `Apollo.sign`).
- Each consumer **app mounts it at `/apollo-verify`** (add the route / SPA history-fallback handling — `codex-playground` is a Vite SPA, so it serves `index.html` for unknown paths; read `location.pathname` + query and render the verify view).

Then a version bump of `codex-ui` (+ `codex-ouronet` if you add the Apollo sign helper there) is what the consumer apps re-pull. **For local testing on `:3009`, no publish is needed** — `codex-playground` uses workspace (`*`) deps, so it picks up the package source directly on rebuild.

## Test checklist

- `localhost:3009/apollo-verify?accounts=<₱.>,<Π.>&challenge=<n>&rp=pythia.ancientholdings.eu&callback=<pythia>/connectors/verify/callback` with **both** keys in the Codex → returns `proofs` with 2 entries → Pythia shows **both verified**, Link lights up.
- Only one key in the Codex → returns 1 proof → Pythia shows **one verified**, prompts for the other; re-open at the Codex holding it → both.
- Wrong Codex (neither) → `proofs=[]` → Pythia shows **none verified**.
- Sign the **exact** canonical message — diff byte-for-byte against `canonicalMessage.ts`.

## When done

Publish the bumped package(s), tell Pythia the round-trip is live, and (per the SSO how-to precedent) drop a short consumer how-to: how a relying party wires the redirect + verifies the returned `proofs`.

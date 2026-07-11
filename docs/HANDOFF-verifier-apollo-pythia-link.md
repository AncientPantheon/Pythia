# Handoff — Apollo-half verifier route (`/pythia-verify`) for the Pythia Link flow

**Audience:** the agent(s) building the verifier side — **OuronetUI** (`wallet` / `devwallet` / localhost), the **standalone Codex**, and **Mnemosyne** (`codex.ancientholdings.eu`).
**Counterpart (already built & live):** Pythia's keyless verification — `POST /api/connectors/verify/start`, `GET /connectors/verify/callback`, `GET /api/connectors/verify/status` (in `apps/pythia/src/routes/connectorVerify.ts` + `apps/pythia/src/connectors/verify/*`).

## What this is

On the Pythia site's **Connectors → Register / Link** tab, a user picks one unlinked **Standard (`₱.`)** half and one unlinked **Smart (`Π.`)** half, then clicks **Verify ownership**. Pythia mints a challenge and redirects the browser to a **verifier** you host. The verifier signs the challenge with the half's **Apollo private key** (which lives in the user's Codex and must never leave the browser) and redirects back to Pythia with the signature(s). Pythia verifies each signature against the half's **on-chain Apollo public key** and, once **both** halves are proven, unlocks the **Link** step.

Pythia stays **keyless** — it only verifies public-data signatures (`Apollo.verify`). Your side does the signing.

This mirrors the existing hub **Ouronet-account** verification (`OuronetUI/src/routes/verify.tsx`, hub `pages/api/admin/account-verification/*`) — **same challenge→sign→return pattern**, but on the **Apollo curve** (`₱./Π.`) instead of the Ouronet Genesis curve (`Ѻ.`). Use `verify.tsx` as your template; the differences are called out below.

## The route to build: `GET /pythia-verify`

**Query params Pythia sends:**

| param | meaning |
|---|---|
| `standard` | the Standard `₱.…` Apollo account to prove |
| `smart` | the Smart `Π.…` Apollo account to prove |
| `challenge` | Pythia-issued single-use nonce (hex) — sign it, echo it back |
| `callback` | absolute Pythia URL to return to (`https://pythia.ancientholdings.eu/connectors/verify/callback`) |

**Behavior:**

1. Require the Codex unlocked (same as `verify.tsx`: "Unlock your Codex first").
2. For **each** of `standard` and `smart`, check whether that Apollo account is present in the currently-unlocked Codex.
   - If present → derive its Apollo keypair from the stored secret and **sign the canonical message** (below) → produce `stdSig` / `smartSig`.
   - If absent → skip it (leave its signature empty) and show the user: *"`<account>` isn't in this Codex — return to Pythia and re-run Verify, opening the Codex that holds it."* (Pythia handles the "one of two verified, verify the other" resume.)
3. Redirect back to Pythia's callback with whatever you signed:
   ```
   <callback>?challenge=<nonce>&stdSig=<sigOrEmpty>&smartSig=<sigOrEmpty>
   ```
   Omit (or leave empty) whichever half you couldn't sign. It's fine to sign only one — the user can come back through another Codex for the other. **If neither is present, still redirect back** (with no sigs) so Pythia's UI can tell the user "none verified."

This is a superset of `verify.tsx` (which signs ONE Ouronet account and returns `?challenge&signature`): here you attempt **both halves in one visit** and return **two** signature slots.

## The canonical message — sign EXACTLY this

Byte-for-byte identical to Pythia's `apps/pythia/src/connectors/verify/canonicalMessage.ts`. For an account `A` and nonce `N`:

```
Pythia · Apollo key ownership
apollo: <A>
nonce: <N>
domain: pythia.ancientholdings.eu
```

(Four lines, `\n`-joined, UTF-8, no trailing newline. `<A>` is the FULL `₱.…`/`Π.…` account string. Note the domain is `pythia.ancientholdings.eu`, NOT the hub's `ancientholdings.eu` — do not reuse the hub message builder.) Sign the Standard half with `apollo:<standard>` and the Smart half with `apollo:<smart>`, both using the **same** `nonce`.

## Signing on the Apollo curve

`verify.tsx` uses `createOuronetAccount(...)` + `schnorrSign(keyPair, msg)` for **Ouronet Genesis (`Ѻ.`)**. For **Apollo (`₱./Π.`)** use the Apollo primitive from the DALOS registry (`@stoachain/dalos-crypto` ≥ 4.0.3, `id: "dalos-apollo"`, Schnorr v2):

```ts
import { Apollo } from "@stoachain/dalos-crypto/registry";
// Re-derive the Apollo keypair from the Codex secret via the same originMode
// paths verify.tsx uses (seedWords / bitString / integerBase10 / integerBase49 /
// bitmap), but through the Apollo primitive instead of the Ouronet Genesis one:
//   Apollo.generateFromSeedWords(words) / .generateFromBitString(bits) / …
// Sanity-check that the derived account matches (fullKey.standardAddress === standard,
// or the smart address === smart) before signing — same guard as verify.tsx.
const sig = Apollo.sign(fullKey.keyPair, buildChallengeMessage(account, nonce));
```

Whether a given account is Standard or Smart is its prefix (`₱.` = U+20B1 standard, `Π.` = U+03A0 smart); the same underlying key produces both address forms, so derive once and pick the address that matches the account you're proving. (If your Codex already stores Apollo accounts with their keypairs, just sign directly — no re-derivation needed.) The private key never leaves the browser; only `sig` is returned.

## The 5 verifier locations

Pythia's location picker points at, per environment: `https://wallet.ouronetwork.io`, `https://devwallet.ouronetwork.io`, `http://localhost:<OuronetUI port>`, `http://localhost:<standalone Codex port>`, `https://codex.ancientholdings.eu`. Each must serve `/pythia-verify` with the contract above. (Pythia's current localhost defaults are `:5173` for OuronetUI and `:5174` for the standalone Codex — tell the Pythia side if those differ so the picker matches.)

## Test checklist

- Deep-link with both halves in the Codex → returns `?challenge&stdSig&smartSig`, Pythia shows **both verified**, Link lights up.
- Deep-link with only one half in the Codex → returns one sig, Pythia shows **one verified**, prompts to verify the other; re-open at the Codex holding the other half → both verified.
- Wrong Codex (neither half) → returns with no sigs; Pythia shows **none verified**.
- Signature is over the **exact** canonical message (a single byte/label difference fails `Apollo.verify` on Pythia — this is the most common integration bug; diff against `canonicalMessage.ts`).

## When done

Publish a short "how-to" for consumers (mirror the SSO how-to precedent): how to register a `₱.`/`Π.` half, land on `/pythia-verify`, and complete a Pythia link. Ping the Pythia side to confirm the localhost ports + do a live end-to-end run.

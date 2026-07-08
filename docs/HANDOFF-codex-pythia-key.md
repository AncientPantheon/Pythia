# Handoff: Codex side of the Pythia consumer-key model

> **WARNING: cross-component interfaces are SETTLED in [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md).** Where naming or any inter-component contract in this doc differs from that ICD - module/read names, the paid field, the redirect-sign return leg, the verifier->Cronoton HMAC envelope, or the activation cap/keyset - **the ICD wins.**

**Audience:** an agent working in the **Codex** repo (`D:\_Claude\AncientPantheon\Codex`).

**Status:** spec ratified (owner + assistant, 2026-07-08). NOT yet implemented. This is
the **Codex-side** work only — and it is deliberately **tiny**. The substance
(on-chain registry, Automaton activation, verifier) lives in DALOS/hub and Pythia.

**Canonical spec (read it first):**
`D:\_Claude\AncientPantheon\Pythia\docs\PYTHIA-CONSUMER-KEY-MODEL.md`
(mirrored decision doc: `Codex/docs/PYTHIA-CONSUMER-KEY-MODEL.md`). Everything below
must stay consistent with that spec's §5 hard rules.

---

## 0. The one-paragraph model (so this handoff stands alone)

A **Pythia API key IS an Apollo Account** — its `₱./Π.` Apollo **public** key. A new
on-chain Pact module holds one row per key `{ apollo-public, consumer-lane, activated,
owner-account, ... }`. A user **deploys** a key (`DeployApolloPythiaApiKey`, charges
**250 STOA** to a treasury, inserts `activated=false` — the paywall is the only
anti-abuse gate; there is **no per-account key limit**). The key is **inert** until its
owner **proves possession** by signing a Pythia-issued nonce **inside Ouronet/Codex,
where the Apollo seed lives**; Pythia verifies the signature off-chain (`Apollo.verify`)
and instructs the **HUB Codex Cronoton** (module-admin keyset holder) to flip
`activated=true` (`TurnApiOn`). The user **cannot** self-activate — activation is
admin-capped, which is exactly why it is a **ping-pong**. Consumers **bake the Apollo
public key at build time**; the Codex reads that baked key and forwards it as the Pythia
request header. This is safe to bake into a public/permaweb bundle **because Pythia is
keyless** — an embedded public key can only burn a lane's rate budget, never move funds.

**The Codex's entire job in this model is four small things (§1–§4 below).** None of them
involves the 250 STOA payment, the Automaton, or any on-chain write — those are hub-side.

---

## 1. Carry the baked Apollo PUBLIC key on the Pythia connection, send it as a header

**File:** `packages/codex-core/src/connection/pythiaConnection.ts`
**Also:** `packages/codex-core/src/connection/index.ts` (barrel re-export of the option type)

`createPythiaConnection(options)` **already exists** and is keyless (see the file header:
"a thin, KEYLESS REST client"). Today `PythiaConnectionOptions` is:

```ts
export interface PythiaConnectionOptions {
  baseUrl: string;
  chainId: string;
  fetchFn?: FetchLike;
}
```

**Change (additive, one field):** add an **optional** `apolloPublicKey` — the consumer's
baked `₱./Π.` Apollo public key — and send it as a request header on `read`/`send`/`poll`
(and, if Pythia wants it, on the `healthz` GET). Suggested header name: `X-Pythia-Key`
(confirm the exact name with the Pythia agent — see §6 open questions).

```ts
export interface PythiaConnectionOptions {
  baseUrl: string;
  chainId: string;
  /** The consumer's BAKED Apollo PUBLIC key (₱./Π.). Public-safe: Pythia is keyless,
   *  so an embedded key grants read+relay only, never fund movement. Absent → the
   *  request goes out unkeyed (community/unregistered lane on Pythia's side). */
  apolloPublicKey?: string;
  fetchFn?: FetchLike;
}
```

In the `postJson` helper, merge the key header when present:

```ts
const headers: Record<string, string> = { "content-type": "application/json" };
if (options.apolloPublicKey) headers["X-Pythia-Key"] = options.apolloPublicKey;
// ...pass `headers` to fetchFn(...)
```

**Invariants to preserve:**
- **Keyless (N-01).** This is a **public** key on a header. Do **not** add any
  `sign`/`seed`/`priv` parameter to `read`/`send`/`poll` — the seam
  (`connection/types.ts`) forbids it and a test asserts it via `@ts-expect-error`.
  The signature over the challenge (§2) is a **separate handshake**, never a request
  parameter here.
- **`FetchLike` already accepts `headers`** (`connection/types.ts` line ~24) — no seam
  change needed.
- **Additive only.** `apolloPublicKey` is optional; existing callers and the two live
  production consumers keep working with zero changes.
- Update the existing test `packages/codex-core/tests/connection-pythia.test.ts` to
  assert the header is sent when the key is present and omitted when it is not.

**This one field is the whole "Codex forwards the consumer's identity" story.** Pythia
reads the header, checks its cached on-chain `activated` set, and grants/attributes the
lane. Per-consumer metering falls out for free — the key told Pythia who it is.

---

## 2. Store the operator's Apollo API-key SEEDS in the existing vault; expose `signChallenge(nonce)`

The Codex is **already a key vault** — it stores Stoa-chain seeds
(`IStoaChainSeed`, with derived `seed.accounts`) and pure keypairs (`IPureKeypair`) in
its encrypted store (`packages/codex-ouronet/src/state/store.ts`,
`packages/codex-core/src/vault/crypto.ts`). It **already derives Apollo keypairs** from a
seed via `deriveDoubleApollo` (`packages/codex-ouronet/src/codex-identity/derivation.ts`),
which enters Apollo through `@stoachain/dalos-crypto/registry` and produces the
`₱./Π.` addresses. **This is the natural home for an operator's many Apollo
API-key seeds** — one seed per Pythia key. Do **not** invent a new vault.

**What to add:** a `signChallenge(nonce, apolloPublicKey)` capability used **only** during
the §3 activation handshake. It:

1. Locates the seed (or pure keypair) in the vault whose derived Apollo **public** key
   matches `apolloPublicKey`.
2. Derives the Apollo keypair client-side (the same `deriveDoubleApollo` path already
   used for identity) and calls the registry primitive's **`sign`**:
   the `CryptographicPrimitive` in `@stoachain/dalos-crypto/registry` exposes
   `sign?(keyPair, message)` / `verify?(sig, message, publicKey)`
   (`dist/registry/primitive.d.ts` lines ~170–176). Apollo's Gen-1 Schnorr v2 signing
   is deterministic.
3. Returns **only the signature string** (plus the `apolloPublicKey` for routing).

**Hard rule (spec §5.1 — non-negotiable):** the **seed/private key NEVER leaves the
Codex**. `signChallenge` runs entirely client-side inside the unlocked wallet; it returns
a **signature**, never seed/scalar/priv material. There is no "send the seed to Pythia"
path anywhere. Pythia receives the signature and runs `Apollo.verify` on **public data
only**.

Signing must require the wallet to be **unlocked** (reuse the existing lock/unlock gate
that `useWallet`/the store already enforce for any signing) — mirror how `SigningZone`
(`packages/codex-ouronet/src/zbom/cfm/SigningZone.tsx`) only surfaces Codex keys when the
wallet is available. Suggested placement: a hook next to the existing signing hooks
(`packages/codex-ouronet/src/hooks/`) or a small helper in `codex-identity/`, exported
through the package barrel so the OuronetUI activation surface can call it.

> **Empirically confirm before shipping** (spec §9 open item): the Apollo
> `generateFromSeedWords → sign → verify` round-trip. `sign`/`verify` are declared
> **optional** on the primitive interface — assert at runtime that the registered Apollo
> primitive actually implements them, and that a signature it produces verifies against
> the derived public key. Fail loudly if not.

---

## 3. Where `signChallenge` is invoked: the Ouronet redirect-and-sign handshake

The activation flow (spec §3b) is a **ping-pong** — the user cannot self-activate; only
the HUB Cronoton flips the switch, and only after ownership is proven:

```
 owner (Ouronet/Codex — seed here)         Pythia (keyless verifier)        HUB Codex Cronoton + chain
 ─────────────────────────────────         ─────────────────────────        ─────────────────────────
 1. "activate my key <apollo-public>" ───▶ 2. mint single-use nonce (TTL), store
                                       ◀─── 3. redirect to Ouronet(nonce, return)
 4. signChallenge(nonce, apollo-public)
    → SIGNATURE  (SEED NEVER LEAVES)
                                       ───▶ 5. return { apollo-public, signature }
                                            6. Apollo.verify(sig, nonce, apollo-public)
                                               + row exists on-chain + Deploy paid
                                               + nonce unconsumed → consume it
                                            7. instruct Cronoton (authed channel) ──▶ 8. TurnApiOn
                                                                                        (admin-capped)
```

**Codex's role is step 4 only:** receive the nonce (via the Ouronet redirect the HUB
**already** uses to verify Ouronet Accounts — this **reuses that proven mechanism**, it is
not new infrastructure), call `signChallenge`, and return the signature to the redirector.
Everything after step 5 (verify, payment check, Cronoton, `TurnApiOn`) is Pythia + hub.

The **UI** that hosts this redirect ("Activate Apollo Pythia API Key") lives in
**OuronetUI**, not in the Codex library — OuronetUI un-gates Apollo Account creation,
bakes its own public key, and drives the handshake. The Codex just **provides the vault +
`signChallenge` primitive** OuronetUI calls. Keep the Codex library free of the redirect
UI and free of any Pythia/HUB URLs.

**Optional (spec §4 signing lane, server-backed consumers only):** the same
`signChallenge(nonce)` doubles as the per-request signing callback for consumers that can
keep a secret at runtime. **Never for a permaweb bundle** — a public bundle has no secret
to sign with (`generateFromSeedWords` is deterministic, so a baked seed would be a
published secret). Default lane is the public-key-identifier lane of §1.

---

## 4. Read the baked key from the CONSUMER (declaration, not detection); keep the library credential-free

**This is the property that keeps the Codex a reusable, consumer-agnostic template — do
not break it.**

- The Codex **must NOT detect its host.** A static/permaweb bundle cannot reliably know
  whether it is OuronetUI vs Mnemosyne vs Aletheia — domain-sniffing is fragile,
  spoofable, and breaks on forks/custom domains. **The consumer DECLARES its identity by
  baking its Apollo public key**; the Codex reads that declaration and forwards it (§1).
- The Codex **hardcodes NO consumer list.** Adding Aletheia = a new on-chain key row +
  that consumer baking its key. **No Codex release, no per-consumer branch, no Pythia
  redeploy.** If you find yourself adding `if (consumer === "aletheia")` anywhere, stop —
  that violates the model.
- **The library stays credential-free.** A published npm package that embedded a key
  would need republishing to rotate it. So the **consumer BUILD** bakes the public key as
  a build-time constant (e.g. `{ pythiaBaseUrl, pythiaApolloPublicKey }` injected via the
  build's env/define), and the Codex library merely **reads** whatever the host injected
  into the connection config (§1's `apolloPublicKey`). Rotation = the **consumer's build
  redeploys** (permaweb apps redeploy to update anyway), never a Codex package republish.
- Local per-user node overrides (the Network tab, `packages/codex-ui/.../NetworkSettingsCard.tsx`)
  still work client-side and are unaffected — they set the base URL / direct node, not the
  key lane.

**Concretely:** the consumer app (e.g. OuronetUI's build, or `apps/codex-playground` as
the standalone) passes its baked `apolloPublicKey` into `createPythiaConnection(...)` when
it constructs the injected connection. The Codex library ships **no** key of its own. The
standalone build MAY bake the shared **community/unregistered** key so it "just works"
with zero setup — that is a build-time constant in the app, not in the library.

---

## 5. Files that matter (Codex side)

| File | Role in this handoff |
| --- | --- |
| `packages/codex-core/src/connection/pythiaConnection.ts` | **§1** — add optional `apolloPublicKey`; send `X-Pythia-Key` header. |
| `packages/codex-core/src/connection/types.ts` | `FetchLike` already takes `headers`; **do not** add key params to the `ChainConnection` seam (N-01). |
| `packages/codex-core/src/connection/index.ts` | Re-export the updated `PythiaConnectionOptions`. |
| `packages/codex-core/tests/connection-pythia.test.ts` | Assert header present-with-key / absent-without. |
| `packages/codex-ouronet/src/codex-identity/derivation.ts` | Existing `deriveDoubleApollo` (Apollo via `@stoachain/dalos-crypto/registry`) — reuse for `signChallenge`. |
| `packages/codex-ouronet/src/state/store.ts`, `packages/codex-core/src/vault/crypto.ts` | Existing encrypted vault — the natural home for Apollo API-key seeds. |
| `packages/codex-ouronet/src/hooks/` | Place a `signChallenge` hook next to the existing signing hooks; export via the barrel. |
| `packages/codex-ouronet/src/zbom/cfm/SigningZone.tsx` | Reference for "only sign when the wallet is unlocked / keys are in the Codex." |
| `docs/CONSUMER-INTEGRATION.md` | Add a short "bake your Pythia Apollo public key at build time; here's why public is safe (Pythia is keyless)" section. |

---

## 6. Open questions to settle with the Pythia agent

1. **Exact header name + error semantics.** `X-Pythia-Key` is a proposal — confirm the
   name Pythia's `resolveConsumer` reads, and the response shape on
   unregistered/inactive/revoked/over-limit (so the Codex can surface a useful state).
2. **Public-key encoding on the wire.** Confirm the header carries the Apollo Account
   `₱./Π.` public-key string **verbatim** (the exact `verify()` input), matching the
   on-chain `apollo-public` row key.
3. **Challenge/return transport.** The nonce redirect + signature return is the HUB's
   existing Ouronet-account verification mechanism — confirm the request/return shape
   (query params vs POST body) so `signChallenge`'s caller in OuronetUI matches it.
4. **`sign`/`verify` availability.** Both are **optional** on the registry primitive —
   confirm the deployed Apollo primitive implements them and that the round-trip verifies
   (spec §9). If Pythia's verifier and the Codex's signer disagree on message encoding
   (string vs `Uint8Array`, nonce framing), activation silently fails — pin this jointly.
5. **Signing lane (optional, later).** If/when the per-request signing lane ships, agree
   whether it is per-request or per-session, and confirm it is **server-consumers only**
   (never a permaweb bundle).

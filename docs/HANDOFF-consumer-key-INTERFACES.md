# Interface Control — Apollo Pythia API-key handoffs (SETTLED contracts)

**This doc is authoritative** for every cross-component interface where the five
handoffs must agree exactly. Each individual handoff flagged some of these as "open";
here they are **settled**. **Where any individual handoff differs from this ICD**
(module/read names, the `paid` field, the redirect-sign return leg, the
Pythia→Cronoton envelope, the activation capability/keyset), **the ICD wins.**

Companion set: `HANDOFF-pact-apollo-pythia-key-module.md`,
`HANDOFF-hub-cronoton-activation.md`, `HANDOFF-ouronetui-apollo-pythia-key.md`,
`HANDOFF-codex-pythia-key.md`, `PYTHIA-CONSUMER-KEY-IMPLEMENTATION.md`. Model:
`PYTHIA-CONSUMER-KEY-MODEL.md`.

---

## 1. Pact module — canonical names (house style is authoritative)

The Pact module follows **OuronetPact house style** — NOT the illustrative
`pythia-consumer-keys` / `UR_PythiaKey*` sketch in the model doc §6. The canonical
surface every other doc must reference:

- **Module `APIARY`** in the Ouronet namespace (`U|CT.CT_NS_USE` — confirm the exact
  namespace string; do **not** hardcode `pythia-keys-ns` or `free.pythia-keys`).
- **Table `APIARY|T|ApiKeys`**, key = the Apollo public string.
- **`C_DeployApolloPythiaApiKey(apollo-public, consumer-name, owner-account)`** —
  user-called; charges 250 STOA + inserts the row (`activated=false`, `paid=true`)
  atomically (see §2).
- **`A_TurnApiOn(apollo-public)` / `A_TurnApiOff(apollo-public)`** — admin-gated by
  `APIARY|A>SET-ACTIVATION` composing `APIARY|CRONOTON` (see §5).
- **Free `/local` reads:** `UR_IsActivated(apollo-public) -> bool`,
  `UR_ApiKeyRow(apollo-public) -> object`, `UR_ListAllApiKeys() -> [object]`, + count.
- Optional: `C_UpdateApiConsumerName(apollo-public, new-name)` against a price.

→ **Cronoton, Pythia-impl, OuronetUI, Codex docs must use these names.** Replace every
`pythia-keys-ns.*`, `UR_PythiaKey*`, `free.pythia-keys.*`, `A_ActivatePythiaKey`
reference with the `APIARY` equivalents above.

## 2. Payment confirmation — the `paid` seam (Pact ↔ Cronoton)

- **`APIARY|T|ApiKeys` carries `paid:bool` + `paid-at:time`.**
- **`C_DeployApolloPythiaApiKey` collects the 250 STOA AND inserts the row with
  `paid=true` in ONE atomic tx** — do the STOA transfer then the `insert` inside the
  same entrypoint (Pact txs are atomic). Do **not** split the fee-collect into a
  separate client op that could be skipped, or `paid` becomes untrustworthy.
- **The Cronoton's payment gate = one read**: `UR_ApiKeyRow(pubkey).paid == true`. No
  treasury-tx scan.

→ Resolves the Pact §3-schema-has-no-`paid` vs Cronoton-needs-`paid` conflict.

## 3. Ownership redirect-sign return leg (OuronetUI ↔ verifier)

Reuses the **existing HUB Ouronet-account-verification redirect-sign flow** (a browser
GET redirect), **not** a POST-JSON body. Fixed shapes:

- **Challenge:** `GET /admin/activate/challenge?apolloPublic=<pub>` → issues a
  single-use, short-TTL `nonce` and **302-redirects** to OuronetUI's sign route with
  `nonce` + `returnUrl`.
- **Return:** OuronetUI signs the `nonce` with the Apollo key (Codex vault, unlocked)
  and **redirects back** to:
  `GET /admin/activate/callback?apolloPublic=<pub>&nonce=<nonce>&signature=<sig>`
- **Field names are fixed:** `apolloPublic`, `nonce`, `signature`. OuronetUI **must**
  carry `apolloPublic` back (the verifier needs it to look up the on-chain pubkey).

→ Resolves the GET-redirect vs POST-JSON and `challenge` vs `nonce` mismatch.

## 4. Verifier → Cronoton activation trigger (verifier ↔ HUB Cronoton)

After the signature verifies, the verifier calls the hub:

- **`POST https://ancientholdings.eu/api/pythia/activate`**.
- **Auth = the hub's existing HMAC `verifyEnvelope`**: HMAC-SHA256 over the canonical
  `{payload, nonce, timestamp}`, ±300 s window, single-use nonce. The shared secret is
  `PYTHIA_CRONOTON_HMAC_SECRET` (rename from `PYTHIA_CRONOTON_TOKEN`). **No** bearer,
  **no** mTLS — one scheme.
- **Payload:** `{ apolloPublic, consumerLane, ownerAccount, verifiedAt, nonceProofRef }`.
- **⚠ Trailing-slash:** the hub is Next.js, so `POST /api/pythia/activate`
  **308-redirects** to `/activate/`. The caller MUST follow it with the manual
  redirect-follow (the `postForm` helper — same gotcha that broke the OIDC token
  exchange) or POST straight to the trailing-slash URL, or the body + HMAC are lost.

→ Resolves the "HMAC-envelope vs open bearer/mTLS" and route-name mismatch.

## 5. Activation capability + keyset the Cronoton signs (Pact ↔ Cronoton)

- The Cronoton flips the switch by signing **`APIARY|CRONOTON`**, guarded by a
  **dedicated `apiary-cronoton-keyset`** — DISTINCT from the Demiurgoi module-admin and
  from the Stoicism-minter keyset.
- The hub's **sealed codex must provision the `apiary-cronoton-keyset`** signing key.

→ Cronoton doc replaces `(pythia-keys-ns.ADMIN)` with `APIARY|CRONOTON` /
`apiary-cronoton-keyset`; APIARY confirms that keyset name is the one the hub holds.

---

## Open (owner/implementers confirm once, then this ICD is updated for all)

- **Final names** (`APIARY`, `apiary-cronoton-keyset`, the exact namespace) are
  house-style proposals — the Pact implementer + hub confirm the exact strings, then
  update **this ICD once** and every doc inherits.
- **Who hosts the verifier — Pythia or the hub** (model doc open §8). §3–§4 above assume
  **Pythia hosts it**. If the **hub** hosts the verifier instead, §3's callback lands on
  the hub and §4 collapses into an internal hub call (no cross-service HMAC hop). Pick
  this first — it decides whether §4 is a network boundary at all.

# pythia-automaton-activation — Design (project)

## Problem

Pythia has, piece by piece, become an automaton: a sealed operator Codex, autonomous Kadena signing
via Khronoton (now delegating to Codex), a self-connector, a registered `dual-link-activate` cronoton,
and a fully-wired headless activation pipeline. But the **operator-facing, end-to-end flow that proves
it all works** doesn't exist yet: an admin should be able to pick a consumer's two Apollo halves,
verify ownership against a verifier (an external Codex, e.g. Mnemosyne), and have Pythia
**autonomously fire `A_LinkDualApiKey`** to activate the dual link. This activation flow is Pythia's
first real self-test as an automaton. Adjacent gaps surfaced alongside it: sub-views aren't
URL-addressable the way Pantheon automatons should be, and there's no "green check" showing Pythia is
live as an automaton.

## What already exists (do NOT rebuild — confirmed by investigation)

- **The entire activation backend is wired end-to-end.** `connectorAuth.ts` (headless challenge/verify)
  → `pendingActivationTracker.recordProof` on a proven not-yet-active half → tracker marks the pair
  ready when both halves are in → `dualLinkActivateResolver` drains it on the Khronoton tick → fires
  `A_LinkDualApiKey`. All deps (`pendingActivation`, `readApolloCounterpart`) are passed at `index.ts`;
  the tracker is started; the resolver is registered.
- **The cronoton is auto-identified by its `serverResolver: "dual-link-activate"` name** — no id
  storage or "tag this cronoton" mechanism is needed; the tick matches it automatically.
- Verifier registry (add/list/enable/remove) + store + admin UI + public list.
- The Apollo-ownership proof primitive: `apolloVerify` (dalos-crypto `Apollo.verify`) + the canonical
  challenge message (`buildChallengeMessage`), byte-identical across the browser and headless flows.
- Hash-addressable tier-1/tier-2 nav (`#connectors/register`, `#self-connector`, …).

## Approach & assumptions (confirm/correct these)

- **Assumption A — Pythia's ADMIN drives the activation-verify** (matches the operator's description:
  operator picks two halves, picks a verifier, Pythia does the round-trip and fires on success). The
  alternative (a consumer's own SDK/Codex calling Pythia's headless routes) is already supported by
  the built backend and needs no Pythia UI — we keep it working, but the new build targets the
  admin-driven path.
- **No C_Link precondition (corrected 2026-08-03, operator).** `A_LinkDualApiKey` is idempotent at the
  Pact level: it flips an existing (`C_Link`'d) inactive link ON, OR creates the link from scratch and
  turns it on if none exists. So `C_Link` is OPTIONAL and this flow works for a pair regardless of
  whether it was pre-linked. The activation UI therefore does NOT need to gate on an inactive-link
  set; a verified pair can be activated directly.
- **Wire, don't rebuild — the verify UI largely EXISTS (operator).** Pythia's admin already lets an
  operator pick the two Apollo halves, hit Verify, and be presented with a verifier picker (currently
  empty — no verifier registered). The missing Pythia piece is: (a) the round-trip against a chosen
  verifier completing, and (b) a thin bridge from a successful ownership proof into
  `pendingActivationTracker.recordProof` — reusing the existing verify primitive + tracker + resolver
  + cronoton, which already do the rest.

Alternatives considered: rebuild a bespoke activation path (rejected — the backend already exists);
drive only from the SDK with no admin UI (rejected — the operator wants the admin self-test).

## Acceptance criteria (project-level — each topic refines its own)

- [ ] From Pythia's admin, an operator can select a consumer's two (inactive-linked) Apollo halves,
      choose a registered verifier, and start an ownership-proof round-trip against it.
- [ ] On both halves proving ownership, the pair lands in `pendingActivationTracker` and Pythia's
      `dual-link-activate` cronoton fires `A_LinkDualApiKey` on its next tick — with NO further
      operator action.
- [ ] The operator can SEE the outcome: the pair goes from inactive → proof recorded → activated
      (surfaced in the admin, not just on-chain).
- [ ] Sub-views involved in this flow (and the other admin tabs) are addressable by their own URL,
      per Pantheon convention — including the verify step.
- [ ] A "green check" liveness surface shows Pythia is live as an automaton (Khronoton tick running,
      activation pipeline ready, self-connector linked), distinct from StoaChain node reachability.
- [ ] Mnemosyne can serve as the verifier (signs Pythia's canonical challenge from its Codex) — via a
      handoff, not built in this repo.

## Out of scope

- Any change to the on-chain modules or the Pact code (`A_LinkDualApiKey` handles the C_Link-optional
  case itself).
- Rebuilding the activation backend (tracker / resolver / cronoton / headless routes) — done.
- Bringing Mnemosyne itself up to automaton status — the OPERATOR drives that with the Mnemosyne
  agent, AFTER Topic 4's verifier doc lands (Topic 5 below is theirs, not a build here).

## Topics

1. `activation-verify-admin-flow` — **(Pythia, core)** WIRE the existing verify UI (pick two halves →
   Verify → verifier picker) to the activation pipeline: complete the round-trip against a chosen
   verifier and BRIDGE a successful ownership proof into `pendingActivationTracker.recordProof` (a
   verified pair → the cronoton fires `A_LinkDualApiKey`, no C_Link precondition). Surface the outcome
   in the admin. Reuses `apolloVerify`, the verifier registry, the tracker/resolver/cronoton. Files:
   `src/routes/connectorVerify.ts` (bridge to the tracker), `src/index.ts` (thread `pendingActivation`
   into the verify deps), `public/{admin,index}.{html,js}` (verifier selection + outcome).
2. `automaton-liveness-indicator` — **(Pythia)** a "green check" that Pythia is LIVE as an automaton —
   every connection / API-link / capability online. Extend `/healthz` with capability flags (khronoton
   tick running, activation pipeline ready, self-connector linked, verifier(s) reachable) + a
   green-check UI on landing/admin. Files: `src/routes/healthz.ts`, `public/index.html`/`app.js`,
   `public/admin.js`.
3. `deeplink-routing` — **(Pythia + docs)** make sub-views their own addressable URL across the WHOLE
   site (public landing AND admin), per Pantheon convention; where a surface already conforms (or a
   deliberate choice not to path-route), DOCUMENT that state in the Pantheonic architecture. Files:
   `public/app.js`/`admin.js` router + a Pantheonic architecture routing-convention doc/update.
4. `PANTHEON DOC: how an entity becomes a Pythia verifier` — a Pantheonic architecture document (NOT a
   Mnemosyne-specific handoff) specifying what an entity must serve to act as a Pythia verifier
   (the `/apollo-verify` / canonical-challenge signing contract), naming **Mnemosyne** and **OuronetUI**
   as the first two supported verifier entities (only these two initially; expansion TBD). This doc is
   what lets the operator then bring Mnemosyne (and OuronetUI) up to verifier status.
5. `(OPERATOR)` bring Mnemosyne up to automaton + verifier status — the operator talks to the
   Mnemosyne agent to scan the Pantheonic architecture, compare against Mnemosyne's implementation,
   and adopt everything (incl. the Topic-4 verifier contract). NOT a build in this repo — gated on
   Topic 4 landing in the Pantheon docs.

Plan Topic 1 in detail first (the core); Topics 2–4 shape when their turn comes.

# Pantheonic Architecture library — doc → destination MAPPING (for approval)

> Nothing moves until the owner approves this. Legend: **[✓]** clear, **[?]** judgment call — confirm.
> Cross-repo moves leave a one-line pointer stub in the origin + repoint all references.
> Destinations are sections under `websites/Pantheon/docs/pantheonic-architecture/`.

## → `automaton/` (how to build an automaton)
| Doc | Origin | Note |
|---|---|---|
| [✓] `04-automaton-blueprint.md` | Mnemosyne/docs/handoffs | THE canonical blueprint; already the reference for all |
| [✓] `02-automaton-master-key-codex-protection.md` | Mnemosyne/docs/handoffs | Sealed-vault crypto standard every automaton reuses (blueprint §6 cites it) |

## → `identity/` (hub login + ownership verification, everywhere)
| Doc | Origin | Note |
|---|---|---|
| [✓] `HANDOFF-ancienthub-sso.md` | Pythia/docs | The central SSO/login *service* — every site depends on it |
| [✓] `HANDOFF-consumer-ancienthub-login.md` | Pythia/docs | The proven "Login-with-AncientHub in any consumer" recipe |
| [✓] `HANDOFF-apollo-ownership-verifier.md` | Pythia/docs | Generic `/apollo-verify`; the doc itself says "any future consumer (e.g. Aletheia) reuses the SAME route" |
| [?] `DUAL-APOLLO-CONSUMER-IDENTITY.md` | Codex/docs | Settled consumer-identity architecture — reusable, but Codex-centric. `identity/` or leave in Codex? |

## → `organs/` (shared constructor packages: codex, khronoton, arweave, pythia-client)
| Doc | Origin | Note |
|---|---|---|
| [✓] `codex-package-blueprint.md` | Khronoton/.bee/recon | Structural template for building *any* constructor package — highly reusable |
| [✓] `07-codex-rekey-primitive.md` | Mnemosyne/docs/handoffs | Codex-package primitive "every automaton [needs]" |
| [✓] `05-khronoton-engine-wire-in.md` | Mnemosyne/docs/handoffs | The *accurate* khronoton package shape (supersedes 03) + how to wire it in |
| [?] `03-khronoton-automaton-package.md` | Mnemosyne/docs/handoffs | **Superseded by 05.** Relocate as history, or leave/drop? |
| [?] `CONSUMER-INTEGRATION.md` | Codex/docs | "Wiring the Codex into a consumer app — any Automaton (Caduceus, Dalos, Mnemosyne)." Reusable → `organs/`. Confirm? |

## → `design/` (NEW — written in topic 2)
| Doc | Origin | Note |
|---|---|---|
| [✓] `PANTHEONIC-DESIGN-ARCHITECTURE.md` | (new) | Width · tokens · header · admin layout · theming. The flagship. |

## → `patterns/` (cross-repo feature reference — present, marked "not required for a new build")
The **Pythia consumer-key / node-pool feature** — a real multi-repo implementation, useful as a worked
example of a Pantheon feature, but NOT a "how to build a new site" standard. Recommend relocating the
**model/architecture** docs here and **leaving the deep per-repo plumbing** with its repo:
| Doc | Origin | Rec |
|---|---|---|
| [?] `PYTHIA-CONSUMER-KEY-MODEL.md` (Pythia + Codex copies) | Pythia/Codex | → `patterns/` (the settled cross-repo model) — or keep in-repo? |
| [?] `HANDOFF-consumer-key-INTERFACES.md` (the ICD) | Pythia | → `patterns/` (the authoritative interface contract) |
| [⬜] `HANDOFF-pact-apollo-pythia-key-module.md` (APIARY) | Pythia | STAY — hub/Pact plumbing, feature-specific |
| [⬜] `HANDOFF-hub-cronoton-activation.md` | Pythia | STAY — hub plumbing |
| [⬜] `HANDOFF-ouronetui-apollo-pythia-key.md` | Pythia | STAY — OuronetUI wiring |
| [⬜] `HANDOFF-hub-nodepool-earnings.md`, `HANDOFF-ancienthub-pythia-nodepool.md`, `HANDOFF-pythia-side-buildout.md` | Pythia | STAY — Pythia node-pool feature |
| [⬜] `HANDOFF-codex-*.md` (pythia-key, apollo-activation-ui, ui-managed-network-tab), `PYTHIA-CONSUMER-KEY-IMPLEMENTATION.md`, `HANDOFF-pythia-dual-apollo.md`, `HANDOFF-ouronetui-consumer-identity.md`, `HANDOFF-codex-aggregate-dts-bundling.md` | Pythia/Codex | STAY — feature/package plumbing |

## ⬜ Stays in its repo (site/package-local — not architecture)
`retainer-01.md` (all repos), `RELEASING.md` (Pythia/Mnemosyne — the *standard* is in the blueprint;
these are the per-site instances), Mnemosyne `v0.1-*.md` + `01-mnemosyne-codex-pact-module.md` +
`04-khronoton-ui-mockup-embed.md`, Codex `CODEX-V2-ARCHITECTURE-PLAN.md` (Codex's own product design)
+ `MIGRATION-kadena-to-stoachain.md`, all package `README.md`s.

## The [?] decisions I need from you
1. **`DUAL-APOLLO-CONSUMER-IDENTITY`** → `identity/`, or leave in Codex?
2. **`03-khronoton-package`** (superseded by 05) → relocate as history, or drop/leave?
3. **`CONSUMER-INTEGRATION`** → `organs/` (my rec), or leave in Codex?
4. **The consumer-key `MODEL` + `INTERFACES` (ICD)** → `patterns/` (my rec: yes; leave the deep plumbing
   in-repo), or keep the whole feature in its repos?
5. **`CODEX-V2-ARCHITECTURE-PLAN`** — I said *stay* (Codex's own product architecture). Agree, or centralize?

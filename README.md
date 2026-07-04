# Pythia

> *The all-seeing gateway of the AncientPantheon.*

A multi-chain **read layer** answering one question: **what is the state
of the world?** Pythia serves two truth-domains through one pooled,
failover-safe API:

- **Chain state** — StoaChain, Arweave, Bitcoin, Ethereum, and every
  other chain the ecosystem bridges to, read via operator-owned nodes
  with third-party fallbacks.
- **External world** — centralized exchange APIs, price aggregators,
  marketplaces; anything an oracle or service needs to observe.

## Role in the Pantheon architecture

Pythia is one of the **three Constructors** — the chain-agnostic
primitives every entity in the ecosystem composes:

| Constructor | Question it answers | This repo |
| ----------- | ------------------- | --------- |
| **Pythia**  | What is the state of the world? | ✅ |
| **Codex**   | Who am I, and how do I sign?    | [AncientPantheon/Codex](https://github.com/AncientPantheon/Codex) |
| **Khronoton** | When do I act?                | [AncientPantheon/Khronoton](https://github.com/AncientPantheon/Khronoton) |

Every **Automaton** (autonomous agent: Aletheia, Caduceus-Automaton,
Dalos-Automaton, Mnemosyne-Automaton), every **Daimon** (human-driven
app: OuronetUI, StoaWallet), and every **Seer** (read-only observer:
StoaExplorer, OuronetExplorer) reads the world through Pythia.

## Planned packages

| Package | Purpose |
| ------- | ------- |
| `@ancientpantheon/pythia-client` | SDK for consumers — native pass-through + normalized cross-chain API |
| `@ancientpantheon/pythia-server` | The gateway service itself (may stay repo-internal) |
| `@ancientpantheon/pythia-adapters-*` | Per-chain backends (stoachain, arweave, bitcoin, ethereum, …) |

## API shape (planned)

Two tiers:

- **Native pass-through** — `/stoachain/rpc`, `/arweave/graphql`,
  `/bitcoin/rpc` — for consumers that already speak a chain's protocol.
- **Normalized cross-chain** — `/api/v1/getBalance?chain=…&address=…`,
  `/api/v1/getConfirmations?chain=…&tx=…` — for consumers that want
  one API across all chains.

MVP scope: StoaChain reads via a two-node operator pool
(`node1.stoachain.com`, `node2.stoachain.com`) with health-check +
failover. Additional chains land as adapters when consumers need them.

## Status

**Scaffold.** No code yet. This is Phase 5 of the AncientPantheon
kickstart plan. Deployment target: `pythia.ancientholdings.eu`.

## License

See [LICENSE](LICENSE) — all rights reserved pending a final
(expected permissive) license decision before first release.

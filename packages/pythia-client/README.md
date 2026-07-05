# @ancientpantheon/pythia-client

The dependency-light consumer SDK for **Pythia**, the all-seeing read
gateway of the AncientPantheon. It wraps the gateway's read API behind a small
typed `PythiaClient` over a configurable base URL:

- **Native pass-through** — `client.rpc(...)` relays a chain payload to the node
  verbatim.
- **Normalized cross-chain** — `client.getBalance(...)` and
  `client.getConfirmations(...)` return decoded, typed StoaChain reads;
  `client.health()` returns the gateway's liveness snapshot.

## Status

`1.0.1` on public npmjs — proprietary release, all rights reserved (see
[LICENSE](./LICENSE)). Ships the
`PythiaClient` class wrapping the four gateway endpoints (`getBalance`,
`getConfirmations`, `rpc`, `health`) over a configurable base URL with an
injectable `fetchImpl`, and mirrors the service error taxonomy as client-side
typed errors (`PythiaValidationError`, `PythiaUnsupportedChainError`,
`PythiaPoolExhaustedError`) under a shared `PythiaClientError` root. The package
carries **no runtime dependencies** — it rests only on the runtime `fetch` and
its own types.

## Usage

```ts
import { PythiaClient } from "@ancientpantheon/pythia-client";

const client = new PythiaClient({ baseUrl: "https://pythia.ancientholdings.eu" });

const balance = await client.getBalance({ address: "k:abc123" });
const status = await client.getConfirmations({ tx: "req-key", chainId: 0 });
const node = await client.rpc({ payload: { exec: { code: "(+ 1 2)" } } });
const health = await client.health();
```

## Install

```sh
npm install @ancientpantheon/pythia-client
```

## Version history

**v1.0.1** — adopt the AncientHoldings proprietary license (all rights reserved),
matching the AncientPantheon family; ship the `LICENSE` in the package tarball.
No API change.

**v1.0.0** — first public release. Ships the `PythiaClient` class over
the four gateway endpoints (`getBalance`, `getConfirmations`, `rpc`, `health`)
with a configurable base URL, an injectable `fetchImpl`, and the client-side
typed error taxonomy. Dependency-light (`fetch` + own types only); establishes
the publishable package shape (`sideEffects: false`, public `publishConfig`,
provenance-signed publish).

## License

**Proprietary — all rights reserved.** © 2026 AncientHoldings. See
[LICENSE](./LICENSE). No rights are granted; publication on npm is for
AncientHoldings' operational convenience only and grants no license to any third
party. For licensing inquiries: ancientholdings.eu.

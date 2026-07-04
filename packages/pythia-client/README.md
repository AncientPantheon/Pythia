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

`1.0.0` on public npmjs — the first public release. Ships the
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

const client = new PythiaClient({ baseUrl: "https://pythia.example" });

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

**v1.0.0** — first public release. Ships the `PythiaClient` class over
the four gateway endpoints (`getBalance`, `getConfirmations`, `rpc`, `health`)
with a configurable base URL, an injectable `fetchImpl`, and the client-side
typed error taxonomy. Dependency-light (`fetch` + own types only); establishes
the publishable package shape (`sideEffects: false`, public `publishConfig`,
provenance-signed publish).

## License

See the repository [LICENSE](../../LICENSE) — all rights reserved pending a
final license decision before first API release.

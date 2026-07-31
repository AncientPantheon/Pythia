# @ancientpantheon/pythia-client

The dependency-light consumer SDK for **Pythia**, the keyless transport
gateway of the AncientPantheon. It wraps the gateway's per-chain transport
surface behind a small typed `PythiaClient` over a configurable base URL:

- **Dirty read** — `client.read(...)` relays a caller-supplied Pact expression
  to a healthy node and returns the node response verbatim (never decoded).
- **Keyless broadcast** — `client.send(...)` relays caller-SIGNED commands to
  the node's `/send` verbatim. Pythia holds no keys and signs nothing.
- **Tx status** — `client.poll(...)` returns per-request-key pending-vs-final
  status and confirmation depth; `client.health()` returns the gateway's
  liveness snapshot.
- **Connector protocol** — `PythiaConnector` drives Pythia's headless
  challenge/verify round trip against an injected signer + storage, holding a
  live ephemeral secret you can wire straight into `PythiaClient` as the
  `x-pythia-key` gated-access header.

## Status

`2.3.0` on public npmjs — proprietary release, all rights reserved (see
[LICENSE](./LICENSE)). Ships the
`PythiaClient` class wrapping the keyless gateway endpoints (`read`, `send`,
`poll`, `health`) over a configurable base URL with an injectable `fetchImpl`,
and mirrors the service error taxonomy as client-side typed errors
(`PythiaValidationError`, `PythiaUnsupportedChainError`,
`PythiaPoolExhaustedError`) under a shared `PythiaClientError` root. Also ships
`PythiaConnector` — the consumer-side orchestrator for Pythia's headless
connector-auth protocol, holding no key material of its own (it signs through
an injected `ApolloSigner` and persists through an injected `SecretStorage`) —
with its own `PythiaConnectorError` taxonomy. The package carries **no runtime
dependencies** — it rests only on the runtime `fetch` and its own types.

## Usage

```ts
import { PythiaClient } from "@ancientpantheon/pythia-client";

const client = new PythiaClient({ baseUrl: "https://pythia.ancientholdings.eu" });

// Dirty read — you supply the Pact code; the node response comes back verbatim.
const node = await client.read({ code: "(coin.get-balance \"k:abc\")" });

// Keyless broadcast — relay your OWN caller-signed commands.
const sent = await client.send({ cmds: mySignedCmds });

// Tx status — pending vs final + depth, per request key.
const status = await client.poll({ requestKeys: ["req-key-1"], chainId: 0 });

const health = await client.health();
```

### Connector protocol (gated access)

If your Apollo account has an active on-chain dual link, `PythiaConnector`
drives the headless challenge/sign/verify round trip for you and hands
`PythiaClient` a live, auto-refreshing secret:

```ts
import { PythiaClient, PythiaConnector } from "@ancientpantheon/pythia-client";

// Your own signing capability — this package never holds key material.
const signer = {
  async sign({ apolloAccount, nonce, rp }) {
    return { signature: await myApolloSigner.sign(apolloAccount, nonce, rp) };
  },
};

const connector = new PythiaConnector({
  baseUrl: "https://pythia.ancientholdings.eu",
  apolloAccount: "₱.my-account...",
  signer,
  // storage defaults to in-memory; inject your own to persist across restarts.
});

const client = new PythiaClient({
  baseUrl: "https://pythia.ancientholdings.eu",
  // Resolved fresh on every request — stays wired to a live secret with no
  // manual refresh loop or client re-construction.
  pythiaKey: connector.keyProvider(),
});

const gatedRead = await client.read({ code: "(coin.get-balance \"k:abc\")" });
```

`connector.ensureSecret()` returns `{status:"pending"}` (not a thrown error)
if your account's ownership is proven but its dual link isn't active on-chain
yet — call it again later once activation lands.

## Install

```sh
npm install @ancientpantheon/pythia-client
```

## Version history

**v2.3.0** — version alignment: jumps from `1.7.0` to `2.3.0` to align with the
unified Pythia service version line. Adds `PythiaConnector` (headless
challenge/sign/verify orchestration against an injected `ApolloSigner` +
`SecretStorage`), the `PythiaConnectorError` taxonomy, `InMemorySecretStorage`,
and `PythiaClientOptions.pythiaKey` (static string or live supplier, sent as
`x-pythia-key`). No removals, no breaking changes to any existing export.

**v1.7.0** — version alignment: jumps from `1.1.0` straight to `1.7.0`,
skipping `1.2.0`–`1.6.0`, to align with the unified Pythia service version
line. No API changes — the service and the client are now released together
from a single git tag.

**v1.1.0** — the gateway pivots from a decode-baked read service to a keyless
generic transport gateway (pre-adoption reshape). Removes `getBalance`,
`getConfirmations`, and
`rpc` (plus the `Balance`/`Confirmations` types) and adds `read` (generic dirty
read), `send` (keyless broadcast of caller-signed commands), and `poll`
(per-request-key tx status). `health()` is unchanged. Node responses from
`read`/`send` pass through verbatim; `poll` returns a typed `PollResult`.

**v1.0.1** — adopt the AncientHoldings proprietary license (all rights reserved),
matching the AncientPantheon family; ship the `LICENSE` in the package tarball.
No API change.

**v1.0.0** — first public release. Shipped the `PythiaClient` class over
the original four gateway endpoints (`getBalance`, `getConfirmations`, `rpc`,
`health`) with a configurable base URL, an injectable `fetchImpl`, and the
client-side typed error taxonomy. Dependency-light (`fetch` + own types only);
established the publishable package shape (`sideEffects: false`, public
`publishConfig`, provenance-signed publish).

## License

**Proprietary — all rights reserved.** © 2026 AncientHoldings. See
[LICENSE](./LICENSE). No rights are granted; publication on npm is for
AncientHoldings' operational convenience only and grants no license to any third
party. For licensing inquiries: ancientholdings.eu.

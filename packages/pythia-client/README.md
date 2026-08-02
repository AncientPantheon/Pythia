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

`2.7.12` on public npmjs — proprietary release, all rights reserved (see
[LICENSE](./LICENSE)). Ships the
`PythiaClient` class wrapping the keyless gateway endpoints (`read`, `send`,
`poll`, `health`) over a configurable base URL with an injectable `fetchImpl`,
and mirrors the service error taxonomy as client-side typed errors
(`PythiaValidationError`, `PythiaUnsupportedChainError`,
`PythiaPoolExhaustedError`) under a shared `PythiaClientError` root. Also ships
`PythiaConnector` — the consumer-side orchestrator for Pythia's headless
connector-auth protocol, holding no key material of its own (it signs through
an injected `ApolloSigner` and persists through an injected `SecretStorage`) —
with its own `PythiaConnectorError` taxonomy. Also ships `splitDualLinkKey`
(validates + splits an on-chain `dual-link-key` into its two Apollo-account
halves, alongside its `APOLLO_ACCOUNT_LEN`/`DUAL_LINK_BAR` constants) and
`DualLinkConnector` (drives both halves of an already-active dual-Apollo pair
on a schedule, reporting one unified status). Also ships `maskSecret` — a
tiny, pure helper for masking an ephemeral secret in a UI (`first7...last7`).
The package carries **no runtime dependencies** — it rests only on the
runtime `fetch` and its own types.

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

### Dual-link connector (an already-active dual-Apollo pair)

If you already have a dual-Apollo pair active on-chain and hold the composite
`dual-link-key` (`<standard-apollo>|<smart-apollo>`, 325 chars), `DualLinkConnector`
drives both halves' proof/refresh round trips for you and reports one unified,
auto-refreshing secret:

```ts
import { PythiaClient, DualLinkConnector } from "@ancientpantheon/pythia-client";

const dualLink = new DualLinkConnector({
  baseUrl: "https://pythia.ancientholdings.eu",
  dualLinkKey: "₱...|Π...", // your on-chain PYTHIA|T|DualLinks composite key
  standardSigner,
  smartSigner,
});

const client = new PythiaClient({
  baseUrl: "https://pythia.ancientholdings.eu",
  pythiaKey: dualLink.keyProvider(),
});

const gatedRead = await client.read({ code: "(coin.get-balance \"k:abc\")" });
```

`dualLink.status()` reports both halves' individual state plus the single
`secret`/`expiresAt` currently in use — whichever half is active first, since
the gate never cares which half issued it.

## Install

```sh
npm install @ancientpantheon/pythia-client
```

## Version history

**v2.7.12** — version alignment: jumps from `2.7.11` to `2.7.12` to align with the unified Pythia
service version line. Service-side only (the Khronoton simulate's real error now surfaces in the UI
instead of a generic "network error") — no changes to this package's own source, API surface, or
behavior.

**v2.7.11** — version alignment: jumps from `2.7.10` to `2.7.11` to align with the unified Pythia
service version line. Service-side only (a hotfix for a khronoton-core 0.6.0 crash that
white-screened the Khronoton admin page) — no changes to this package's own source, API surface, or
behavior.

**v2.7.10** — version alignment: jumps from `2.7.9` to `2.7.10` to align with the unified Pythia
service version line. Service-side only (the Khronoton Builder admin UI gained a Back button) — no
changes to this package's own source, API surface, or behavior.

**v2.7.9** — version alignment: jumps from `2.7.8` to `2.7.9` to align with the unified Pythia
service version line. Service-side only (the Khronoton admin now surfaces a throwing handler's real
error instead of a generic "network error") — no changes to this package's own source, API surface,
or behavior.

**v2.7.8** — version alignment: jumps from `2.7.7` to `2.7.8` to align with the unified Pythia
service version line. Service-side only (the Khronoton Kadena signing-key picker now excludes
Apollo-format keys by key shape, fixing a case v2.7.7's metadata filter missed) — no changes to this
package's own source, API surface, or behavior.

**v2.7.7** — version alignment: jumps from `2.7.6` to `2.7.7` to align with the unified Pythia
service version line. Service-side only (Khronoton admin: the Server Resolver dropdown now offers
the already-registered resolvers, and the Kadena signing-key picker excludes Apollo-curve keys) —
no changes to this package's own source, API surface, or behavior.

**v2.7.6** — version alignment: jumps from `2.7.5` to `2.7.6` to align with the unified Pythia
service version line. Service-side only (Self Connector panel: seconds-ticking countdown + a
normal, non-square Link button) — no changes to this package's own source, API surface, or
behavior.

**v2.7.5** — version alignment: jumps from `2.7.4` to `2.7.5` to align with the unified Pythia
service version line. Service-side only (Self Connector panel layout fix + an already-linked pair
no longer shows a false "Not linked" after a redeploy) — no changes to this package's own source,
API surface, or behavior.

**v2.7.4** — version alignment: jumps from `2.7.3` to `2.7.4` to align with the unified Pythia
service version line. Service-side only (fixes a race where an in-flight blue-green deploy could
silently undo an admin's Pyth ledger "Nuke") — no changes to this package's own source, API
surface, or behavior.

**v2.7.3** — version alignment: jumps from `2.7.2` to `2.7.3` to align with the unified Pythia
service version line. Service-side only (the admin Self Connector panel now shows a single
consolidated ephemeral secret, matching `DualLinkConnector.status()`'s own already-existing dedup,
instead of two misleading per-half ones) — no changes to this package's own source, API surface, or
behavior.

**v2.7.2** — version alignment: jumps from `2.7.1` to `2.7.2` to align with the unified Pythia
service version line. Service-side only (Self Connector's Link action now drives an immediate
chain check instead of waiting up to 24h for the next scheduled tick) — no changes to this
package's own source, API surface, or behavior.

**v2.7.1** — version alignment: jumps from `2.7.0` to `2.7.1` to align with the unified Pythia
service version line. A CI-flakiness fix on the service side only (test-timing budget, no
production code changed) — no changes to this package's own source, API surface, or behavior.

**v2.7.0** — version alignment: jumps from `2.6.0` to `2.7.0` to align with the unified Pythia
service version line. Service-side only (Pythia's self-connector signing now routes through her
own Codex instead of generating locally) — no changes to this package's own source, API surface,
or behavior.

**v2.6.0** — adds `maskSecret(secret)` (a tiny, pure, dependency-free helper masking an ephemeral
secret to `first7...last7` for display, returning short inputs — under 14 chars — unchanged), and
fixes `APOLLO_ACCOUNT_LEN`/`DUAL_LINK_BAR` (from `v2.5.0`'s `dualLinkKey.ts`) not having been
re-exported from the package's top-level `index.ts` despite existing in source. No removals, no
breaking changes to any existing export.

**v2.5.0** — adds `splitDualLinkKey` (validates + splits an on-chain `dual-link-key` —
`<standard-apollo>|<smart-apollo>`, the literal `PYTHIA|T|DualLinks` table key, 325 chars — into its
two Apollo-account halves, throwing `PythiaConnectorValidationError` naming the specific problem on
malformed input) and `DualLinkConnector` (the class-shaped generalization of the service's own
`SelfConnectorLoop` pattern: given a `dualLinkKey` plus a signer per half, drives both halves'
proof/refresh round trips on a schedule with per-half error isolation, and reports one unified
`status()` — both halves' state plus a single live `secret`/`expiresAt` — with a `keyProvider()` for
direct `PythiaClientOptions.pythiaKey` wiring). The reusable primitive any consumer needs to
actually USE an already-active on-chain dual-Apollo identity. No removals, no breaking changes to
any existing export.

**v2.4.3** — version alignment: jumps from `2.4.2` to `2.4.3` to align with the unified Pythia
service version line. Fixes the actual on-box deploy failure (a `Dockerfile` runtime-stage bug) —
no changes to this package's own source, API surface, or behavior.

**v2.4.2** — version alignment: jumps from `2.4.1` to `2.4.2` to align with the unified Pythia
service version line. Service-side only (a `SealedStore.rotateMasterKey` hardening fix) — no
changes to this package's own source, API surface, or behavior.

**v2.4.1** — version alignment: jumps from `2.4.0` to `2.4.1` to align with the unified Pythia
service version line. CI-only fix (the ghcr image workflow now builds this package before its test
gate) — no changes to this package's own source, API surface, or behavior.

**v2.4.0** — version alignment: jumps from `2.3.0` to `2.4.0` to align with the unified Pythia
service version line. Service-side only (Pythia adopting this SDK as her own third organ) — no
changes to this package's own source, API surface, or behavior.

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

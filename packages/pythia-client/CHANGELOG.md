# Changelog

All notable changes to `@ancientpantheon/pythia-client` are documented here.

## 1.7.0 — 2026-07-15

Version alignment: the client jumps from `1.1.0` straight to `1.7.0`,
skipping `1.2.0`–`1.6.0`, to align with the unified Pythia service version
line. No API changes — this is a version-only release; the service and the
client are now released together from a single git tag.

## 1.1.0 — 2026-07-05

The Pythia gateway pivots from a decode-baked read-only service to a keyless
generic transport gateway; the SDK surface is reshaped to match (pre-adoption —
no downstream consumers yet).

- Removed: `getBalance`, `getConfirmations`, and `rpc` methods, plus the
  `Balance` and `Confirmations` response types. The gateway no longer decodes
  chain data.
- Added: `read({ chainId?, code, data?, sender? })` — a generic dirty read; the
  caller supplies the Pact code and the node response is returned verbatim.
- Added: `send({ chainId?, cmds })` — a keyless broadcast that relays the
  caller-SIGNED `cmds` array to the node's `/send` verbatim. The client holds no
  keys and signs nothing.
- Added: `poll({ chainId?, requestKeys })` — per-request-key tx status,
  returning a typed `PollResult` (`{ chainId, finalityDepth, results }`).
- `health()` is unchanged. The client-side typed error taxonomy
  (`PythiaClientError` root + `PythiaValidationError` /
  `PythiaUnsupportedChainError` / `PythiaPoolExhaustedError`) and the `code`
  discriminator remapping are unchanged.

## 1.0.1 — 2026-07-05

- License: adopt the AncientHoldings proprietary license (all rights reserved),
  matching the AncientPantheon family (`@ancientpantheon/khronoton-core`). The
  `LICENSE` file now ships inside the published package tarball.
- Docs: point the usage example at the live gateway
  (`https://pythia.ancientholdings.eu`). No API change.

## 1.0.0 — 2026-07-04

First public release.

- `PythiaClient` class over a configurable `baseUrl` with an injectable
  `fetchImpl`, wrapping the four gateway endpoints: `getBalance`,
  `getConfirmations`, `rpc` (verbatim node relay), and `health`. The client
  always sets `chain=stoachain` itself.
- Client-side typed error taxonomy mirroring the service: `PythiaClientError`
  (shared root) + `PythiaValidationError`, `PythiaUnsupportedChainError`, and
  `PythiaPoolExhaustedError` (carrying `failures[]` + optional `chainId`).
- Typed response shapes: `Balance`, `Confirmations`, `HealthSnapshot` (amounts
  are decimal strings).
- Dependency-light: no runtime dependencies — rests only on the runtime `fetch`
  and its own types. Publishable package shape established: `sideEffects: false`,
  public `publishConfig`, provenance-signed publish via the tag-triggered
  workflow.
- README `## Status` + version-history and this changelog held at `1.0.0`
  parity to satisfy the publish version-gate.

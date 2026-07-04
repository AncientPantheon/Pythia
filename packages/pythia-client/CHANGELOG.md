# Changelog

All notable changes to `@ancientpantheon/pythia-client` are documented here.

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

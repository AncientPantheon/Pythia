# pythia-client-connector-sdk — Plan

Topic 3 of the pythia-connector-protocol project (design:
`docs/work/pythia-client-connector-sdk/design.md`). Test command:
`npm test -w @ancientpantheon/pythia-client`. Package root: `packages/pythia-client`.

## Wave 1

- [ ] T1: `packages/pythia-client/src/connectorErrors.ts` — the connector protocol's own typed
      error taxonomy — done when: exports `PythiaConnectorError` (extends `Error`, `name =
      "PythiaConnectorError"`, mirrors `errors.ts`'s `PythiaClientError` root pattern exactly —
      read that file first as the template), and four subclasses following the same
      constructor/`name`-stamping shape: `PythiaConnectorValidationError` (400 — invalid apollo
      account on challenge, OR invalid/expired nonce on verify — both are caller/environment
      input problems, share one class), `PythiaConnectorSignatureError` (401 — signature
      verification failed), `PythiaConnectorNotLinkedError` (403 — not an active dual link, no
      pairing hook available), `PythiaConnectorUnavailableError` (502 — verification temporarily
      unavailable). Each subclass constructor takes just `(message: string)` like the existing
      subclasses do. Tests: each subclass is `instanceof` both itself and
      `PythiaConnectorError` and `Error`; each has the right `.name`.
  - files: `packages/pythia-client/src/connectorErrors.ts`, `packages/pythia-client/src/connectorErrors.test.ts`

- [ ] T2: `packages/pythia-client/src/secretStorage.ts` — the `SecretStorage` injection point —
      done when: exports interface `SecretStorage = { load(): Promise<{secret: string; expiresAt:
      number} | null>; save(entry: {secret: string; expiresAt: number}): Promise<void>; clear():
      Promise<void>; }` and a trivial default implementation `class InMemorySecretStorage
      implements SecretStorage` backed by one private nullable field (no TTL logic of its own —
      `PythiaConnector`, not the storage, decides staleness). Tests: `save` then `load` round-trips
      the exact entry; `clear` makes a subsequent `load` return `null`; a fresh instance's `load`
      returns `null`.
  - files: `packages/pythia-client/src/secretStorage.ts`, `packages/pythia-client/src/secretStorage.test.ts`

## Wave 2 (depends on Wave 1)

- [ ] T3: `packages/pythia-client/src/connector.ts` — `PythiaConnector`, the challenge → sign →
      verify → store orchestrator — done when:
      - Exports `interface ApolloSigner { sign(input: {apolloAccount: string; nonce: string; rp:
        string}): Promise<{signature: string}>; }` — the consumer's own signing injection point,
        this SDK never holds key material.
      - Exports `type ConnectorSecretResult = {status: "active"; secret: string; expiresAt: number}
        | {status: "pending"}`.
      - Exports `interface PythiaConnectorOptions { baseUrl: string; apolloAccount: string; signer:
        ApolloSigner; storage?: SecretStorage; fetchImpl?: typeof fetch; refreshMarginMs?: number;
        }` (`storage` defaults to a fresh `InMemorySecretStorage`; `refreshMarginMs` defaults to 5
        minutes — a cached secret within this margin of `expiresAt` is treated as needing refresh,
        not just already-expired, so a consumer's in-flight request doesn't race an
        about-to-expire secret).
      - `class PythiaConnector` constructed with `PythiaConnectorOptions`, using `Transport`
        internally (import from `./transport.js` — same class `PythiaClient` already uses; read
        `client.ts` first for the exact usage pattern) for the two POST calls — do not hand-roll
        `fetch`.
      - `async ensureSecret(): Promise<ConnectorSecretResult>` — loads from `storage`; if present
        AND `entry.expiresAt - refreshMarginMs > Date.now()`, returns `{status:"active", secret:
        entry.secret, expiresAt: entry.expiresAt}` WITHOUT any network call; otherwise calls
        `refresh()` and returns its result.
      - `async refresh(): Promise<ConnectorSecretResult>` — unconditionally: POST
        `/connectors/auth/challenge` with `{apolloAccount}`; on non-200, `challenge` only ever
        returns 400 per the locked wire contract — map to `PythiaConnectorValidationError` and
        throw. On 200, call `deps.signer.sign({apolloAccount, nonce, rp})`, then POST
        `/connectors/auth/verify` with `{apolloAccount, nonce, signature}`. Map the verify
        response: 200 → `await storage.save({secret, expiresAt})`, return
        `{status:"active",secret,expiresAt}`; 202 → `await storage.clear()` (a previously-cached
        secret, if any, must not be handed back once the account is known not-yet-active — an
        edge case but a real one if `ensureSecret` is ever called again after a dual link is
        deactivated), return `{status:"pending"}`; 400 → throw
        `PythiaConnectorValidationError`; 401 → throw `PythiaConnectorSignatureError`; 403 →
        throw `PythiaConnectorNotLinkedError`; 502 → throw `PythiaConnectorUnavailableError`; any
        other status → throw base `PythiaConnectorError` with a message naming the unexpected
        status.
      - `keyProvider(): () => Promise<string | undefined>` — returns a closure that calls
        `ensureSecret()` and returns `result.status === "active" ? result.secret : undefined` (and
        swallows a thrown `PythiaConnectorError` into `undefined` too — a supplier feeding
        `PythiaClientOptions.pythiaKey` must never itself throw and break an unrelated read/send/
        poll call; log the swallowed error via `console.error` so it isn't silent).
      Tests: a fresh connector's `ensureSecret()` with a signer/verify stub that succeeds does the
      full 3-call sequence (challenge, sign, verify) and returns `{status:"active",...}`; a second
      `ensureSecret()` call right after returns the cached value with ZERO additional calls to the
      injected `fetchImpl`/signer (spy-count assertion); a verify stub returning 202 yields
      `{status:"pending"}` and does not throw; each of the four error-mapped statuses (400 on
      verify, 401, 403, 502) throws the right subclass — verify by `instanceof`; a 400 on
      `/connectors/auth/challenge` itself (before any sign/verify call happens) throws
      `PythiaConnectorValidationError` and never calls the signer; `keyProvider()`'s returned
      closure resolves to a secret string on success and to `undefined` (not a throw) when the
      underlying `ensureSecret()` rejects.
  - files: `packages/pythia-client/src/connector.ts`, `packages/pythia-client/src/connector.test.ts`

## Wave 3 (depends on Wave 2)

- [ ] T4: Wire `pythiaKey` into the existing `Transport`/`PythiaClient` — done when:
      - `packages/pythia-client/src/types.ts`'s `PythiaClientOptions` gains one new optional field:
        `pythiaKey?: string | (() => string | undefined | Promise<string | undefined>);` with a
        doc comment explaining the gating semantics (undefined/resolves-to-undefined → today's
        unchanged anonymous behavior, never sends an empty header).
      - `packages/pythia-client/src/transport.ts`'s `Transport` resolves `pythiaKey` (calling it if
        it's a function, awaiting the result) on EVERY request (both `get` and `postJson`) and
        sets the `x-pythia-key` header when the resolved value is a non-empty string; sets no such
        header at all otherwise. Keep this resolution logic in one private method so `get`/
        `postJson` both call it rather than duplicating the string-vs-function check.
      - No other existing `Transport`/`PythiaClient` method signature changes — this is additive
        only; every existing test in `transport.test.ts`/`client.test.ts` (which never pass
        `pythiaKey`) must keep passing UNCHANGED.
      Tests (in `transport.test.ts`, mirroring its existing fetchImpl-spy style): a
      `PythiaClientOptions` with no `pythiaKey` sends no `x-pythia-key` header at all (assert on
      the captured request `init.headers`, not just "response is fine"); a static string
      `pythiaKey` sends exactly that value on both a `get` and a `postJson` call; a supplier
      function `pythiaKey` is called fresh on each request (assert call count across 2 requests)
      and its resolved value is sent; a supplier resolving to `undefined` sends no header (proves
      the "falls through to anonymous" contract, not an accidental `"undefined"` string header).
  - files: `packages/pythia-client/src/types.ts`, `packages/pythia-client/src/transport.ts`, `packages/pythia-client/src/transport.test.ts`

- [ ] T5: End-to-end integration — `PythiaConnector.keyProvider()` actually reaches
      `PythiaClient`'s `x-pythia-key` header — done when: a new test file wires a REAL
      `PythiaConnector` (real collaborator, not mocked — mirrors the
      `dualLinkActivateResolver.test.ts` "integration" test pattern on the service side: fake only
      the network boundary, not the classes under test) into a REAL `PythiaClient` via
      `pythiaKey: connector.keyProvider()`, against one shared `fetchImpl` stub that routes by URL
      path (`/connectors/auth/challenge`, `/connectors/auth/verify`, `/stoachain/read`). Test:
      calling `client.read(...)` triggers the full connector round trip transparently and the
      captured `/stoachain/read` request carries `x-pythia-key: <the secret the verify stub
      returned>`; a SECOND `client.read(...)` call reuses the cached secret (no second
      challenge/verify round trip) and still carries the same header.
  - files: `packages/pythia-client/src/connectorIntegration.test.ts`

- [ ] T6: Export the new surface + version/changelog/README — done when:
      - `packages/pythia-client/src/index.ts` exports `PythiaConnector`, `type ApolloSigner`,
        `type ConnectorSecretResult`, `type PythiaConnectorOptions`, `InMemorySecretStorage`,
        `type SecretStorage`, `PythiaConnectorError`, `PythiaConnectorValidationError`,
        `PythiaConnectorSignatureError`, `PythiaConnectorNotLinkedError`,
        `PythiaConnectorUnavailableError` (mirror the existing export grouping style already in
        this file).
      - Root `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`,
        and `apps/pythia/src/version.ts` all bump to the same next patch/minor version (confirm the
        exact next version number against the CURRENT value at build time — this is additive new
        capability with no breaking change to existing exports, so minor per semver and this
        package's own precedent of feature-adding minors like `1.1.0`).
      - `packages/pythia-client/CHANGELOG.md` gains a new top `##` entry (today's date, this
        session) documenting: added `PythiaConnector`/`ApolloSigner`/`SecretStorage`/
        `InMemorySecretStorage`, added `PythiaClientOptions.pythiaKey`, new
        `PythiaConnectorError`-rooted taxonomy — no removals, no breaking changes.
      - `packages/pythia-client/README.md`'s `## Status` line is updated to the new version
        (`` `X.Y.Z` on public npmjs ``), a new `**vX.Y.Z**` paragraph is added to the version
        history section (mirroring the existing entries' style), and a short new usage example
        showing `PythiaConnector` + `keyProvider()` wired into `PythiaClient` is added after the
        existing usage block.
      - `npm run typecheck -w @ancientpantheon/pythia-client`, `npm test -w
        @ancientpantheon/pythia-client`, and `npm run build -w @ancientpantheon/pythia-client` all
        clean.
      - Dry-run `publish.yml`'s own three documentation-gate greps locally against the new version
        string (README `## Status` line, README `**vX.Y.Z**` heading, CHANGELOG first `##`
        heading) and confirm all three match — this is the exact gate that would otherwise fail
        the real workflow.
      - `apps/pythia`'s full suite (`npm test -w @ancientpantheon/pythia`) still green — this
        touches `apps/pythia/src/version.ts`, a file that other suite covers.
  - files: `packages/pythia-client/src/index.ts`, root `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`, `apps/pythia/src/version.ts`, `packages/pythia-client/CHANGELOG.md`, `packages/pythia-client/README.md`

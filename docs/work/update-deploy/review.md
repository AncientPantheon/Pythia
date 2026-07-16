# update-deploy — Review

Rounds: 2 (find → fix → clean). Scope: the deploy diff — `apps/pythia/src/deploy/*`,
`apps/pythia/src/routes/adminDeploy.*`, `apps/pythia/src/index.ts`, `Dockerfile`,
`apps/pythia/public/{admin.html,admin.js}`, `deploy/host/*`, `deploy/DEPLOY-RUNBOOK.md`.
Lenses: correctness, security, tests (root-privileged host scripts + a network-facing container are
the risk surface). All findings adversarially validated against the cited code.

## Findings (all fixed)

### [CRITICAL] Root deployer could follow container-planted symlinks → arbitrary root-file clobber
- The spool dir was container-writable (`chown 1001`) and root wrote `<id>.log`/`<id>.status` there
  with no symlink guard, so a compromised container (the blueprint's stated threat model) could
  `ln -s /etc/passwd <id>.status` and have root truncate it.
- **Fix:** split the spool — `requests/` (container-writable, drop-only; root reads only the
  id-validated *filename*, never content into a shell) and **`state/` (root-owned `0755`, where root
  writes log/status; the container can't create/rename/symlink there)**. Plus a belt-and-suspenders
  `[ -L ]` refusal in the deployer and `umask 022` so the state files stay world-readable for the
  container's SSE tail. Verified: installer `chown root:root state/`, `chown 1001:1001 requests/`;
  spool.ts `requestsDir()`/`stateDir()` match; `seedDeployFiles` now writes only the request.

### [MEDIUM] Installer/runbook first-deploy text contradicted the cold-start color logic — fixed
- Cold start (no `pythia-green`) deploys green/8081, but the text claimed blue/8080. **Fix:** docs now
  state the one-time migration *manually* starts `pythia-blue` on 8080 (matching the seeded upstream),
  and the Deploy button alternates thereafter.

### [MEDIUM] SIGKILL/timeout (>1800s) left status stuck "running" + orphaned the claim — fixed
- **Fix:** `trap '... echo failed >"$STATUS"' TERM INT` in the deployer; the scan script reclaims stale
  `*.request.json.processing` on entry (id-guarded), writing `failed` to state.

### [MEDIUM] SSE test only hit the already-terminal path — fixed
- **Fix:** a new test opens the stream at `queued`, appends log chunks and flips status across polls,
  asserting separate `data:` deliveries + an `event: status` transition before `event: done` — it now
  exercises the byte-offset tail loop.

### [MEDIUM] 20-min stream-cap default unasserted — fixed
- **Fix:** exported `DEFAULT_MAX_STREAM_MS = 1_200_000`, used as the default, with a value assertion.

### [LOW] SSE terminal added a spurious `\n` per chunk — fixed
- **Fix:** `append(e.data)` (the chunk carries its own newlines).

## Clean pass
- `node --check admin.js` OK; `npm test` → `apps/pythia 274 passed (43 files)`, `pythia-client 42
  passed (6 files)`; `npm run typecheck` OK; `npm run build` OK; `bash -n` OK on all three shell
  scripts; keyless-invariant `11 passed`.
- Behavioral (browser, mocked ancient): the Update & Deploy view shows the status block + Deploy
  button (correctly disabled when status is unreachable) + SSE terminal + port-juggle note + retained
  seed-pair health.
- **Live end-to-end proof:** recorded in this topic's `## Live proof` below after the VPS install +
  migration + one real deploy.

## Live proof
(appended after T6 install/migration + T7 proof deploy)

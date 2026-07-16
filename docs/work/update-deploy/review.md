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

## Live proof (LittleBrother, 2026-07-16)
Install + one-time migration: installer created `requests/` (`chown 1001`, container-writable) +
`state/` (`chown root`, container can't symlink there) — the CRITICAL fix verified on disk; Caddy
vhost switched to `import /etc/caddy/pythia-upstream.caddy` (validated + reloaded, no disruption);
`pythia` → `pythia-blue` on 8080 (healthy in 1s).

The proof surfaced (and the run fixed) three real first-install bugs — each is exactly what the
mandatory live proof exists to catch:
1. deployer forced `DOCKER_BUILDKIT=1` but the host has no buildx → fall back to the legacy builder.
2. host scripts committed from Windows without the exec bit → `git reset` (run by the deployer)
   stripped it → systemd `203/EXEC` → marked the scripts `100755` in git.
3. `mktemp` made the Caddy snippet `0600`, unreadable by the `caddy` reload user → `chmod 0644`.

Final proof deploy — request dropped **from inside `pythia-green` as uid 1001** (the real spool path,
never the docker socket) → host path-unit → deployer:
```
current live: green · deploying to: blue (127.0.0.1:8080)
✓ new container healthy   → flip Caddy → 8080 → Valid configuration
✓ Caddy now routing to blue   ✓ old container (pythia-green) stopped + removed   ✓ deploy complete
status: success
```
**Zero downtime: `30 × 200` through `https://pythia.ancientholdings.eu` across the swap, zero non-200.**
Full blue↔green alternation demonstrated (migration→blue, blue→green, green→blue). Deploy button +
SSE terminal + status block are live behind the ancient gate.

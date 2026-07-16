# update-deploy — Plan

> Executes `docs/work/update-deploy/design.md` (honey run). Reference: Mnemosyne `deploy/host/*` +
> `app/api/admin/deploy/*` (nginx→Caddy adapted). Test command: `npm test -w @ancientpantheon/pythia`
> (colocated vitest; new src code gets real tests). T6/T7 are orchestrator ops tasks (SSH), not
> implementer dispatches.

## Wave 1
- [x] T1: Deploy spool module — done when: `apps/pythia/src/deploy/spool.ts` exports
      `deploySpoolDir()` (env `PYTHIA_DEPLOY_DIR`, no default → null = dev mode),
      `deployMode()` (`'bundle'` when spool dir set AND `NODE_ENV==='production'`, else `'dev'`),
      `isValidDeployId(id)` (`/^[a-f0-9-]{8,64}$/i`), `requestPath/logPath/statusPath(id)`,
      `readStatus(id)` (trimmed word or null), `isTerminalStatus(s)` (`success|failed`), and
      `seedDeployFiles(id, requestBody)` (mkdir -p spool; write `<id>.log` header line + `<id>.status`
      "queued" + `<id>.request.json` JSON — atomic tmp+rename for the request file);
      `apps/pythia/src/deploy/spool.test.ts` covers: dev mode when env unset; id validation rejects
      `../evil` and empty; seed creates the three files with queued status; readStatus round-trip;
      isTerminalStatus. Checkable: `npm test -w @ancientpantheon/pythia` green including the new file.
  - files: `apps/pythia/src/deploy/spool.ts`, `apps/pythia/src/deploy/spool.test.ts`

- [x] T2: Host-side deployer bundle (checked-in files, installed later by T6) — done when these exist
      under `deploy/host/` and are internally consistent (paths/names/ports agree): (a)
      `pythia-deploy.sh` — root blue-green deployer: args `<id>`; resolves SPOOL from
      `PYTHIA_SPOOL` env or `docker volume inspect pythia-data` mountpoint + `/deploy`; logs to
      `$SPOOL/$id.log` (append, line-buffered) + one-word `$SPOOL/$id.status`
      (running→success|failed, ERR trap→failed); steps: `cd /opt/pythia` → `git fetch origin main +
      git reset --hard origin/main` → `docker build -t pythia:latest .` (streamed into the log) →
      detect live color (`docker ps` has `pythia-green` → OLD=green NEW=blue else OLD=blue NEW=green;
      BLUE_PORT=8080 GREEN_PORT=8081) → start `pythia-$NEW` on `127.0.0.1:$NEW_PORT:$NEW_PORT` with
      `-e PORT=$NEW_PORT -e PYTHIA_COLOR=$NEW --env-file /opt/pythia/pythia.env -v pythia-data:/data
      --restart unless-stopped` → health `curl -fsS http://127.0.0.1:$NEW_PORT/healthz` up to 30×2s
      (failure → remove new container, status failed, old untouched) → atomic Caddy flip: write
      `reverse_proxy 127.0.0.1:$NEW_PORT` to a tmp file, `mv` over `/etc/caddy/pythia-upstream.caddy`,
      `caddy validate --config /etc/caddy/Caddyfile` (failure → restore previous snippet, status
      failed, new container removed) → `systemctl reload caddy` → graceful `docker stop pythia-$OLD`
      + `docker rm pythia-$OLD` → status success; (b) `pythia-deploy-scan.sh` — snapshot-and-re-exec
      (`PYTHIA_SNAPSHOT` guard, `mktemp -d` copy) then claim loop over `$SPOOL/*.request.json` via
      atomic `mv "$req" "$req.processing" || continue`, runs `pythia-deploy.sh "$id"`, removes the
      claim; (c) `pythia-deploy.path` — `PathExistsGlob=<spool>/*.request.json` (spool path
      documented as rewritten by the installer to the real volume path) + `pythia-deploy.service` —
      `Type=oneshot`, root, `TimeoutStartSec=1800`, ExecStart the scan script from `/opt/pythia`;
      (d) `install-host-deployer.sh` — idempotent root installer: chmod +x scripts, resolve the
      pythia-data volume mountpoint, `install -d` the `deploy/` spool inside it `chown 1001:1001`,
      write `/etc/caddy/pythia-upstream.caddy` (`reverse_proxy 127.0.0.1:8080`) if absent, print the
      one-line vhost edit needed (`import pythia-upstream.caddy` replacing the hardcoded
      reverse_proxy), render the `.path` unit with the resolved spool glob into
      `/etc/systemd/system/`, copy the service unit, `systemctl daemon-reload && systemctl enable
      --now pythia-deploy.path`; (e) `deploy/DEPLOY-RUNBOOK.md` documenting the mechanic, the spool
      protocol, the ports/colors, rollback (`docker start pythia-$OLD` + snippet restore), and that
      public ports stay 80/443. Checkable: `bash -n` passes on all three .sh files; ports/names/paths
      grep-consistent across the five files.
  - files: `deploy/host/pythia-deploy.sh`, `deploy/host/pythia-deploy-scan.sh`,
    `deploy/host/pythia-deploy.path`, `deploy/host/pythia-deploy.service`,
    `deploy/host/install-host-deployer.sh`, `deploy/DEPLOY-RUNBOOK.md`

## Wave 2 (depends on Wave 1)
- [x] T3: Deploy API routes — done when: `apps/pythia/src/routes/adminDeploy.ts` registers, all
      ancient-gated with the same guard used by `admin/routes.ts`: `GET /api/admin/deploy/status` →
      `{mode, color: env.PYTHIA_COLOR||null, port: env.PORT, version: PYTHIA_VERSION, container:
      color?('pythia-'+color):null}` (no-store); `POST /api/admin/deploy` → dev mode → 409
      `{error:'dev mode'}`, else mint `crypto.randomUUID()`, `seedDeployFiles(id, {id, mode:'bundle',
      requestedAt})`, → `{id, mode:'bundle'}`; `GET /api/admin/deploy/stream/:id` → 400 on invalid id,
      else SSE (Hono streamSSE): every 500ms tail `<id>.log` from a byte offset emitting `data:`
      chunks, emit `event:status` on change, `event:done` + close on terminal status, 20-min cap.
      `apps/pythia/src/routes/adminDeploy.test.ts` covers: 401/403 when not ancient; status
      dev-mode shape; POST in dev → 409; POST in bundle mode (temp spool dir env) creates the three
      spool files with queued status and returns the id; stream 400 on `../evil`; stream replays an
      existing log and closes on terminal status (write success status in the test). Checkable:
      `npm test -w @ancientpantheon/pythia` green; keylessScanner untriggered (no banned imports).
  - files: `apps/pythia/src/routes/adminDeploy.ts`, `apps/pythia/src/routes/adminDeploy.test.ts`

- [x] T4: Wiring + image env — done when: `apps/pythia/src/index.ts` registers the deploy routes
      (only when the admin/OIDC surface is registered, same condition as other admin routes) and
      `Dockerfile` sets `ENV PYTHIA_DEPLOY_DIR=/data/deploy`; `npm run build` + full suite green.
  - files: `apps/pythia/src/index.ts`, `Dockerfile`

## Wave 3 (depends on Wave 2)
- [x] T5: Update & Deploy panel UI — done when: the `update-deploy` view in
      `apps/pythia/public/admin.html`+`admin.js` gains a **deploy status block** (live color, loopback
      port, container name, version — from `GET /api/admin/deploy/status`; dev mode → "dev mode —
      on-box deploy available on the live server only" and the button disabled), a **Deploy button**
      (confirm dialog → `POST /api/admin/deploy` → opens the stream), and an **SSE terminal** (`<pre>`
      autoscrolled; `EventSource('/api/admin/deploy/stream/'+id)`, buffer reset `onopen` so the
      reconnect-across-swap replays cleanly, closed on `event:done` with a success/failed line; POST
      409/errors rendered inline). The existing version/seed-pair-health readout stays. Blue/green +
      the 8080/8081 port-juggling depicted in a short static note. Checkable: `node --check`;
      full suite green; behavioral pass at review.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## Wave 4 (ops — orchestrator over SSH, depends on Wave 3 + pushed main)
- [x] T6: VPS install + one-time migration — done when: on LittleBrother the installer has run
      (spool dir on the volume, chown 1001; upstream snippet present; vhost imports it; caddy
      validate OK; path-unit enabled+active), and the running `pythia` container is replaced by
      `pythia-blue` (port 8080, `PYTHIA_COLOR=blue`, `PYTHIA_DEPLOY_DIR=/data/deploy`, env-file +
      volume as before); public site answers before and after; `/api/admin/deploy/status` (with an
      ancient session — or verified via container env inspection) reports blue/8080.
  - files: (ops — LittleBrother: /etc/caddy/*, /etc/systemd/system/pythia-deploy.*, containers)

- [x] T7: End-to-end proof deploy — done when: a spool request written via the container path (or the
      real admin button) triggers the deployer; the log streams; the color flips blue→green (or
      green→blue); `docker ps` shows the new color on the other port; the Caddy snippet points at the
      new port; a curl-poll loop against https://pythia.ancientholdings.eu/healthz during the swap
      records zero failed requests; the SSE log tail is captured as evidence.
  - files: (ops — evidence quoted in review.md)

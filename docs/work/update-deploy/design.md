# update-deploy — Design

> Honey-run topic (B of 2). Topic 4 of pythia-constructor-service: the real on-box tokenless Deploy
> with zero-downtime blue-green via Caddy. Reference: Mnemosyne `deploy/host/*` +
> `app/api/admin/deploy/*` (nginx) — adapted to Pythia's Hono/vanilla stack and Caddy.

## Problem
Deploying Pythia is manual (SSH → git pull → docker build → stop/rm/run) with a downtime blip and no
operator visibility. The blueprint's §3 mechanic — an ancient-gated Deploy button that rebuilds from
source on the box with zero downtime and a live build log — is the missing core of the Update &
Deploy panel, which today only shows version + seed-pair health.

## Acceptance criteria (the confirmed outcome)
- [ ] The **Update & Deploy** panel shows which **color** (blue/green) is live, on which **loopback
      port**, which **container**, and the running **version** — plus a **Deploy** button.
- [ ] Pressing Deploy rebuilds Pythia from `origin/main` **on the box** — no tokens, no docker
      socket (the container only drops a spool request file; a root systemd path-unit runs the
      privileged deployer) — and swaps colors with **zero downtime** (new container health-checked on
      the alternate loopback port before Caddy flips to it; old stopped after).
- [ ] The panel streams the **live build log** (SSE terminal) and the stream **survives the swap**
      (log lives on the host volume; EventSource reconnects to the new container).
- [ ] The live server is migrated to the scheme: containers `pythia-blue`/`pythia-green` on
      `127.0.0.1:8080`/`127.0.0.1:8081`, Caddy proxying via a snippet the deployer rewrites +
      gracefully reloads. **No firewall changes** (public stays 80/443).
- [ ] **Proof:** one real deploy triggered through the spool mechanism completes with the color
      swapped, the SSE log captured, and the public site answering throughout (no dropped requests
      during polling).
- [ ] Localhost dev is deploy-mode-aware: the panel reports dev mode and the Deploy button is
      disabled (no spool on dev).
- [ ] Keyless invariant holds (CI keylessScanner green); full suite green.

## Out of scope
- The Security vault (next round). Two-tier verifiers. ghcr-pull deploys (box builds from source).
- "Update available" detection — the button always rebuilds latest `main`.
- Public-site changes.

## Decisions
Autonomous run confirmed 2026-07-16.
- Ports blue=8080 / green=8081 (loopback-only); container names `pythia-blue`/`pythia-green`; the
  running container learns its color/port via `PYTHIA_COLOR`/`PORT` env set by the deployer.
- Spool + logs at `/data/deploy` on the EXISTING `pythia-data` named volume — the host deployer reads
  it via the docker volume mountpoint (`docker volume inspect`), so no bind-mount migration and zero
  risk to verifiers/settings/stats data.
- Caddy swap: the vhost imports `/etc/caddy/pythia-upstream.caddy` (containing
  `reverse_proxy 127.0.0.1:<port>`); the deployer rewrites the snippet atomically, `caddy validate`,
  then graceful `systemctl reload caddy`; on validation failure the old snippet is restored (site
  unaffected).
- Spool protocol mirrors Mnemosyne verbatim: `<id>.request.json` / `<id>.log` (append-only) /
  `<id>.status` (queued→running→success|failed) / `.processing` claim via atomic `mv`; deployer
  scripts snapshot-and-re-exec before `git pull` rewrites them.
- SSE: 500ms poll tail from a byte offset, 20-min cap, uuid-validated id (path-traversal guard);
  client resets its buffer on reconnect.
- Health check before flip: `GET /healthz` on the new container's port, up to 30×2s.
- Deploy mode: `production` when `PYTHIA_DEPLOY_DIR` is set AND `NODE_ENV=production`; otherwise the
  status API reports `dev` and POST /api/admin/deploy returns 409.
- One-time migration performed by the orchestrator over SSH: stop `pythia` → start `pythia-blue`
  (same image, port 8080, + `PYTHIA_COLOR=blue` + `PYTHIA_DEPLOY_DIR=/data/deploy`) → install Caddy
  snippet + vhost import + deployer units. One manual-deploy-sized blip, then never again.

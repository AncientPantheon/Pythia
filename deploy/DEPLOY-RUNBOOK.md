# Pythia on-box deploy — runbook

Zero-downtime blue-green deploy of Pythia on the live box (LittleBrother), triggered
from the ancient-gated **Update & Deploy** admin panel — no tokens, no docker socket
in the container. This documents the mechanic, the spool protocol, the ports/colors,
and rollback. For day-one container/env details see the repo-root `DEPLOY.md`.

## The mechanic

The container is keyless and unprivileged (uid 1001) — it cannot build images,
manage containers, or touch Caddy. The privileged half lives on the host:

1. The operator presses **Deploy** in `/admin` → `POST /api/admin/deploy` mints a
   uuid and drops `<id>.request.json` into the **requests** dir at
   `/data/deploy/requests` — a directory on the existing `pythia-data` named volume.
   The container-writable requests dir is the ONLY place uid 1001 writes; the log +
   status live in the root-owned **state** dir (`/data/deploy/state`), which the
   container can READ (for the SSE stream) but not write.
2. On the host, that same base is `<volume mountpoint>/deploy`, split into
   `requests/` (container-writable, uid 1001) and `state/` (root-owned, mode 0755).
   A systemd path unit (`pythia-deploy.path`,
   `PathExistsGlob=<base>/requests/*.request.json`) fires `pythia-deploy.service`
   (oneshot, root, 1800s timeout), which runs `pythia-deploy-scan.sh` from
   `/opt/pythia`.
3. The scan script **snapshots itself + the deployer to a `mktemp -d` dir and
   re-execs from there** (guard env: `PYTHIA_SNAPSHOT`) — the deploy resets the repo
   these scripts live in, and bash must never have its running script rewritten
   underneath it. On entry it also **reclaims stale claims** — any orphaned
   `requests/<id>.request.json.processing` left by a SIGKILL/timeout gets its
   `state/<id>.status` set to `failed` and the claim file removed. It then validates
   each id (`^[a-f0-9-]{8,64}$`, skipping crafted filenames), claims each request
   atomically (`mv <req> <req>.processing` within `requests/`), and runs
   `pythia-deploy.sh <id>`.
4. The deployer streams everything into `state/<id>.log` on the shared volume; the
   container tails that file back to the browser over SSE
   (`GET /api/admin/deploy/stream/:id`), so the operator watches the build live —
   and because the log is on the volume, **the stream survives the container swap**
   (the EventSource reconnects to the new color and replays).

`pythia-deploy.sh <id>` performs the blue-green swap:

| Step | Action | On failure |
|---|---|---|
| 1 | `cd /opt/pythia` → `git fetch origin main` + `git reset --hard origin/main` | ERR trap → status `failed` |
| 2 | `docker build -t pythia:latest .` (BuildKit, streamed to the log) | ERR trap → status `failed` |
| 3 | Detect live color via `docker ps`; start `pythia-$NEW` on `127.0.0.1:$NEW_PORT` (`-e PORT` `-e PYTHIA_COLOR` `--env-file /opt/pythia/pythia.env` `-v pythia-data:/data` `--restart unless-stopped`) | ERR trap → status `failed` |
| 4 | Health check: `curl -fsS http://127.0.0.1:$NEW_PORT/healthz`, up to 30×2s | new container removed, **old untouched**, status `failed` |
| 5 | Atomic Caddy flip: write `reverse_proxy 127.0.0.1:$NEW_PORT` to a tmp file, `mv` over `/etc/caddy/pythia-upstream.caddy`, `caddy validate --config /etc/caddy/Caddyfile` | previous snippet restored, new container removed, status `failed` |
| 6 | `systemctl reload caddy` (graceful — no dropped connections) | ERR trap → status `failed` |
| 7 | Graceful `docker stop pythia-$OLD` (SIGTERM flushes the stats snapshot) + `docker rm pythia-$OLD` → status `success` | — |

The old container serves every request until step 6 completes — **zero downtime**.
Beyond the ERR trap, `pythia-deploy.sh` also installs a `trap … TERM INT` so a
systemd SIGKILL/timeout or Ctrl-C writes `failed` to the status instead of leaving it
stuck at `running`; the scan script's stale-claim reclaim then clears the orphan.

## Spool protocol

Spool base: `/data/deploy` in the container = `$(docker volume inspect -f
'{{.Mountpoint}}' pythia-data)/deploy` on the host (override for either script via
`PYTHIA_SPOOL`). The base is **split into two dirs** so root never writes into a
container-writable directory:

- `requests/` — **container-writable** (uid 1001 owns it, mode 0755). The container
  drops `<id>.request.json` here; the path unit watches `requests/*.request.json`.
- `state/` — **root-owned**, mode 0755 (world-readable so the uid-1001 container can
  READ, but not write, the log/status for the SSE stream). The deployer writes
  `<id>.log` + `<id>.status` here.

| File | Dir | Writer | Meaning |
|---|---|---|---|
| `<id>.request.json` | `requests/` | container | deploy request (`{id, mode, requestedAt}`); its existence triggers the path unit |
| `<id>.request.json.processing` | `requests/` | host | atomic claim (`mv`); removed when the deploy ends (or reclaimed on the next scan if orphaned) |
| `<id>.log` | `state/` | host | append-only build/deploy log; container reads it over SSE |
| `<id>.status` | `state/` | host | one word: `running` → `success` \| `failed` |

`<id>` is a uuid, validated (`^[a-f0-9-]{8,64}$`) before any path is built — both the
container (on write) and `pythia-deploy-scan.sh` (on claim + reclaim, skipping any
non-matching filename) enforce it — no traversal.

## Ports and colors

| Color | Container | Loopback bind | When live |
|---|---|---|---|
| blue | `pythia-blue` | `127.0.0.1:8080` | snippet says `reverse_proxy 127.0.0.1:8080` |
| green | `pythia-green` | `127.0.0.1:8081` | snippet says `reverse_proxy 127.0.0.1:8081` |

Each deploy flips to the color NOT currently running (`docker ps` has
`pythia-green` → deploy blue; otherwise deploy green). The running container knows
its side via `PYTHIA_COLOR` and `PORT` (set by the deployer). **Public ports never
change: Caddy keeps terminating 80/443**; only the loopback upstream in
`/etc/caddy/pythia-upstream.caddy` moves. No firewall changes, ever.

## Install (once, as root on the box)

```sh
cd /opt/pythia && git pull
bash deploy/host/install-host-deployer.sh
```

The installer is idempotent: it makes the scripts executable, resolves the volume
mountpoint, creates `requests/` (chowned to uid 1001) and `state/` (root-owned),
drops the upstream snippet if absent, renders the `.path` unit to watch
`requests/*.request.json` (the checked-in unit carries a `__PYTHIA_SPOOL__`
placeholder for the requests dir), installs both units, and enables the watcher. It
then PRINTS the one manual step: in the Caddy vhost, replace
`reverse_proxy 127.0.0.1:8080` with `import /etc/caddy/pythia-upstream.caddy`.

## One-time migration (before the first Deploy)

The deploy **script never produces blue-on-8080 on a cold start** — its color
detection deploys **green on `127.0.0.1:8081`** whenever no `pythia-green` container
is running. So the switch from the single legacy `pythia` container to the blue-green
pair is done **manually**, once, seeding the **blue** side to match the upstream
snippet (`reverse_proxy 127.0.0.1:8080`):

```sh
docker stop pythia && docker rm pythia    # graceful — flushes the stats snapshot
docker run -d --name pythia-blue --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -e PORT=8080 -e PYTHIA_COLOR=blue \
  --env-file /opt/pythia/pythia.env -v pythia-data:/data pythia:latest
```

Thereafter the **Deploy** button alternates blue↔green automatically: because
`pythia-blue` (not green) is now live, the **first button-deploy flips to
green/8081**, the next back to blue/8080, and so on.

## Rollback

The deployer fails safe: a failed health check or `caddy validate` leaves the old
container live and untouched. If a bad build slipped past `/healthz` and you must
revert manually after a completed swap:

1. `docker start pythia-$OLD` — the retired color's container is removed on
   success, so if it is gone: `docker run -d --name pythia-$OLD --restart
   unless-stopped -p 127.0.0.1:$OLD_PORT:$OLD_PORT -e PORT=$OLD_PORT -e
   PYTHIA_COLOR=$OLD --env-file /opt/pythia/pythia.env -v pythia-data:/data
   pythia:latest` (use a previous image tag if `latest` is the bad build).
2. Wait for `curl -fsS http://127.0.0.1:$OLD_PORT/healthz`.
3. Restore the snippet:
   `printf 'reverse_proxy 127.0.0.1:%s\n' $OLD_PORT > /etc/caddy/pythia-upstream.caddy`
4. `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`
5. Gracefully retire the bad color: `docker stop pythia-$NEW && docker rm pythia-$NEW`.

Watching a deploy from the host instead of the panel:

```sh
SPOOL="$(docker volume inspect -f '{{.Mountpoint}}' pythia-data)/deploy"
tail -f "$SPOOL"/state/<id>.log ; cat "$SPOOL"/state/<id>.status
journalctl -u pythia-deploy.service -f
```

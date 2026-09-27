#!/usr/bin/env bash
#
# Pythia on-box deployer — zero-downtime blue-green rebuild + swap.
#
# Runs on the HOST as root (never in the container) so it can build images, manage
# containers, and reload Caddy — power the keyless app container deliberately does
# NOT have. It is triggered by a request file the container drops in the deploy
# spool (POST /api/admin/deploy) and streams all progress into `<id>.log`, which
# the container tails back to the operator's browser over SSE.
#
# Blue-green: rebuild the image from origin/main, start it as the OTHER color on
# the OTHER loopback port (blue=8080, green=8081), health-check it, atomically flip
# Caddy's upstream snippet to it, then gracefully retire the old color. The site is
# served by the old container the entire time until Caddy flips — no interruption,
# and the public ports (80/443, terminated by Caddy) never change.
#
# Usage: pythia-deploy.sh <deploy-id>
set -Eeuo pipefail

# The container (uid 1001) tails state/<id>.log + reads state/<id>.status over SSE,
# so every file root creates in the state dir MUST be world-readable regardless of
# the host's inherited umask — pin it rather than trust the environment.
umask 022

ID="${1:?usage: pythia-deploy.sh <deploy-id>}"

# ── Box paths (override via env if your layout differs) ──────────────────────────
REPO="${PYTHIA_REPO:-/opt/pythia}"
ENV_FILE="${PYTHIA_ENV_FILE:-/opt/pythia/pythia.env}"
IMAGE="${PYTHIA_IMAGE:-pythia:latest}"
UPSTREAM_INC="${PYTHIA_CADDY_UPSTREAM:-/etc/caddy/pythia-upstream.caddy}"
CADDYFILE="${PYTHIA_CADDYFILE:-/etc/caddy/Caddyfile}"
BLUE_PORT=8080
GREEN_PORT=8081

# The spool base lives at <pythia-data mountpoint>/deploy — the same named volume the
# container mounts at /data (PYTHIA_DEPLOY_DIR=/data/deploy). It is SPLIT into two
# dirs so root never writes into a container-writable directory:
#   <base>/requests — CONTAINER-WRITABLE (uid 1001): the container drops
#                     <id>.request.json here; the path unit watches it.
#   <base>/state    — ROOT-OWNED, mode 0755 (world-readable so the uid-1001 container
#                     can READ, but not write, the log/status for the SSE stream).
#                     The deployer writes <id>.log + <id>.status HERE.
if [ -n "${PYTHIA_SPOOL:-}" ]; then
  SPOOL="$PYTHIA_SPOOL"
else
  SPOOL="$(docker volume inspect -f '{{.Mountpoint}}' pythia-data)/deploy"
fi
REQ_DIR="$SPOOL/requests"
STATE_DIR="$SPOOL/state"

LOG="$STATE_DIR/$ID.log"
STATUS="$STATE_DIR/$ID.status"

# Belt-and-suspenders: the container can write the requests dir but NOT the state dir,
# so log/status can never be pre-seeded as a symlink by the unprivileged side — but if
# either path is a symlink, refuse rather than let root follow it to write elsewhere.
if [ -L "$LOG" ] || [ -L "$STATUS" ]; then
  echo "refusing: $ID log/status is a symlink" >&2
  exit 1
fi

START=$(date +%s)
elapsed() { printf '%dm%02ds' $(( ($(date +%s)-START)/60 )) $(( ($(date +%s)-START)%60 )); }
log()   { printf '%s\n' "$*" >>"$LOG"; }
phase() { log ""; log "═══ [$(elapsed)] $* ═══"; }
fail()  { log "✗ $*"; echo failed >"$STATUS"; exit 1; }

# ── Heartbeat: the canonical "always-moving" guarantee ────────────────────────────
# A long docker step (the native better-sqlite3 build, the chown -R) emits nothing for
# minutes, so the SSE terminal looks frozen even though the deploy is fine. A background
# ticker appends a heartbeat line every few seconds so the log ALWAYS grows — the operator
# can tell at a glance the deploy is alive; if the heartbeat STOPS, it is genuinely stuck.
HEARTBEAT_PID=""
start_heartbeat() {
  ( while true; do sleep 6; printf '  · still working · elapsed %s\n' "$(elapsed)" >>"$LOG"; done ) &
  HEARTBEAT_PID=$!
}
stop_heartbeat() { [ -n "$HEARTBEAT_PID" ] && kill "$HEARTBEAT_PID" 2>/dev/null; HEARTBEAT_PID=""; }
trap 'stop_heartbeat' EXIT

trap 'log "✗ deploy aborted (error near line $LINENO)"; echo failed >"$STATUS"' ERR
# A SIGKILL/timeout (systemd) or Ctrl-C must not leave status stuck at "running":
# mark failed on TERM/INT so the panel and the stale-claim reclaim agree.
trap 'echo failed >"$STATUS" 2>/dev/null; exit 1' TERM INT

# Create the log fresh in the (root-owned) state dir before writing status.
: >"$LOG"
echo running >"$STATUS"
log "▶ host deployer started ($(date -u +%FT%TZ))"
start_heartbeat

# 1) Refresh source to exactly origin/main (reset --hard: the box's checkout is a
#    build input, never a place local edits live).
phase "1/5 · Refresh source (origin/main) + bump constructors to @latest"
cd "$REPO"
git fetch origin main 2>&1 | tee -a "$LOG"
# reset --hard also discards the PREVIOUS deploy's pin bumps, so the tree stays clean
# and @latest re-bumps from a known base (same model as the Mnemosyne deployer).
git reset --hard origin/main 2>&1 | tee -a "$LOG"

# Adopt the newest published organs. The image builds with `npm ci`, which installs the
# lockfile EXACTLY — so without this step a deploy can never pick up a newly published
# constructor, no matter what the admin panel advertises as available. Bumping the pins
# here (package.json + package-lock) before the build is what makes "Deploy" actually
# adopt Codex/Khronoton releases. See automaton/05 §1c.
#
# npm runs in a THROWAWAY CONTAINER, not on the host: this box is deliberately minimal
# (Docker only — no Node/npm installed), so calling npm directly aborts the deploy with
# "npm: command not found". The same node image the build uses is already local/cached.
#
# BEST-EFFORT: a registry hiccup must not fail an otherwise-good deploy. On failure we log
# and continue, building the constructor pins committed on main.
log "→ bumping constructors to @latest (npm in a throwaway node container)"
BUMPED=0
if docker run --rm -v "$REPO":/w -w /w node:22-alpine \
     npm install @ancientpantheon/codex@latest @ancientpantheon/khronoton-core@latest \
     -w @ancientpantheon/pythia --no-audit --no-fund 2>&1 | tee -a "$LOG"; then
  BUMPED=1
  log "✓ constructor pins bumped to @latest"
else
  log "⚠ constructor bump failed — continuing with the pins committed on main"
fi

# 2) Build the new image. Prefer BuildKit + --progress=plain (line-by-line, no
#    cursor-rewrite → cleaner SSE terminal) WHEN buildx is present; otherwise fall
#    back to the legacy builder, which streams fine and is all some hosts have.
build_image() {
  if DOCKER_BUILDKIT=1 docker buildx version >/dev/null 2>&1; then
    DOCKER_BUILDKIT=1 docker build --progress=plain -t "$IMAGE" "$REPO" 2>&1 | tee -a "$LOG"
  else
    log "(buildx not present — using the legacy builder)"
    docker build -t "$IMAGE" "$REPO" 2>&1 | tee -a "$LOG"
  fi
}

phase "2/5 · Build image"
# The @latest bump in step 1 is BEST-EFFORT — but until now only a *registry* failure
# was handled, not an *incompatible release*. On 2026-09-27 codex@0.11.0 widened its
# `SeedType` with "stoic" while khronoton-core's mirrored `StoaChainSeedType` still had
# the old three, so `tsc` failed inside the image build and EVERY deploy died at this
# phase — including deploys carrying Pythia's own unrelated fixes. A constructor's
# breaking release must never hold Pythia's releases hostage.
#
# So: if the build fails AND we bumped, restore the pins committed on main and rebuild
# once. Only a failure on BOTH is a real deploy failure. (`if !` suppresses `set -e`/the
# ERR trap for the probe, which is exactly what we want here.)
if ! build_image; then
  if [ "$BUMPED" = 1 ]; then
    log "⚠ build FAILED with constructors at @latest — an incompatible constructor release."
    log "  Restoring the pins committed on main and rebuilding ONCE."
    git -C "$REPO" reset --hard origin/main 2>&1 | tee -a "$LOG"
    if ! build_image; then
      fail "build failed with BOTH @latest and the committed constructor pins"
    fi
    log "✓ built with the COMMITTED constructor pins — @latest is broken, see the tsc errors above."
    log "  Pythia deployed fine; the constructor needs a fix before its @latest is usable."
  else
    fail "docker build failed (constructors were already at the committed pins)"
  fi
fi

# 3) Pick the target color (the one NOT currently serving).
if docker ps --format '{{.Names}}' | grep -qx 'pythia-green'; then
  OLD=green; NEW=blue;  NEW_PORT=$BLUE_PORT
else
  OLD=blue;  NEW=green; NEW_PORT=$GREEN_PORT
fi
log "→ current live: $OLD · deploying to: $NEW (127.0.0.1:$NEW_PORT)"

# 4) Start the NEW container. Same named volume → same connectors/settings/stats/
#    verifiers data AND the same /data/deploy spool this very log lives on, which
#    is what lets the SSE stream survive the swap. PORT + PYTHIA_COLOR tell the
#    container which side of the blue-green pair it is.
phase "3/5 · Start new container (pythia-$NEW · 127.0.0.1:$NEW_PORT)"
docker rm -f "pythia-$NEW" >/dev/null 2>&1 || true  # stale corpse from a failed run
docker run -d --name "pythia-$NEW" --restart unless-stopped \
  -p "127.0.0.1:$NEW_PORT:$NEW_PORT" \
  -e PORT="$NEW_PORT" \
  -e PYTHIA_COLOR="$NEW" \
  --env-file "$ENV_FILE" \
  -v pythia-data:/data \
  "$IMAGE" 2>&1 | tee -a "$LOG"

# 5) Health-check the new container before routing any traffic to it.
phase "4/5 · Health-check new container"
healthy=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$NEW_PORT/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  log "  … waiting for /healthz (attempt $i/30)"
  sleep 2
done
if [ "$healthy" != 1 ]; then
  docker rm -f "pythia-$NEW" >/dev/null 2>&1 || true
  fail "new container failed health check — old container kept live, nothing changed"
fi
log "✓ new container healthy"

# 6) Flip Caddy to the new port: atomic snippet replace (tmp file in the SAME
#    directory so mv is an atomic same-filesystem rename) + validate + graceful
#    reload. On validation failure the previous snippet is restored byte-for-byte
#    and the site never notices.
phase "5/5 · Cut over (Caddy) + retire old container"
log "→ flipping Caddy upstream to 127.0.0.1:$NEW_PORT"
prev="$(mktemp)"
had_prev=0
if [ -f "$UPSTREAM_INC" ]; then cp "$UPSTREAM_INC" "$prev"; had_prev=1; fi
tmp="$(mktemp "$UPSTREAM_INC.XXXXXX")"
printf 'reverse_proxy 127.0.0.1:%s\n' "$NEW_PORT" >"$tmp"
mv "$tmp" "$UPSTREAM_INC"
# caddy.service reloads as the 'caddy' user, not root — it must be able to READ
# the snippet. mktemp creates 0600, so widen to 0644 or the reload fails with
# "permission denied" even though `caddy validate` (run here as root) passed.
chmod 0644 "$UPSTREAM_INC"
if ! caddy validate --config "$CADDYFILE" 2>&1 | tee -a "$LOG"; then
  if [ "$had_prev" = 1 ]; then mv "$prev" "$UPSTREAM_INC"; else rm -f "$UPSTREAM_INC" "$prev"; fi
  docker rm -f "pythia-$NEW" >/dev/null 2>&1 || true
  fail "caddy validate failed — previous snippet restored, old container kept live"
fi
rm -f "$prev"
systemctl reload caddy 2>&1 | tee -a "$LOG"
log "✓ Caddy now routing to $NEW (127.0.0.1:$NEW_PORT)"

# 7) Retire the old color GRACEFULLY: docker stop (SIGTERM → the server flushes
#    its stats snapshot) then rm — never `rm -f` (SIGKILL loses un-flushed counts).
docker stop "pythia-$OLD" >/dev/null 2>&1 || true
docker rm "pythia-$OLD" >/dev/null 2>&1 || true
log "✓ old container (pythia-$OLD) stopped + removed"

# 8) Reclaim the image the retired color was running.
#    `docker build -t pythia:latest` UNTAGS the previous image rather than deleting it,
#    so EVERY deploy leaves one dangling <none> layer set behind. Nothing ever pruned
#    them: ~250 accumulated (~179 GB) and filled the 232 GB disk to 100% on 2026-09-27,
#    wedging the box — journald "No space left on device", then the OOM killer took
#    chainweb-node, and Pythia (the fleet chokepoint) went dark for a day.
#
#    Placement matters, twice over:
#      · AFTER the old container is removed — Docker refuses to prune an image that a
#        container still references, so pruning any earlier reclaims nothing at all.
#      · ONLY on the success path — `fail()` exits, so a failed or rolled-back deploy
#        still keeps the prior image intact and re-runnable.
#
#    `docker image prune -f` removes ONLY dangling <none> images. The two live TAGGED
#    images (this deploy's pythia:latest and the chainweb node's stoa-node:latest) are
#    never candidates. Build cache is capped by age rather than wiped, so the next
#    deploy still gets a warm npm ci / better-sqlite3 layer.
#
#    Best-effort throughout: a cleanup failure must never fail an otherwise-good deploy.
log "→ reclaiming dangling images (root fs free before: $(df -Ph / | awk 'NR==2{print $4}'))"
docker image prune -f 2>&1 | tee -a "$LOG" || log "⚠ image prune failed — continuing"
docker builder prune -f --filter until=168h 2>&1 | tee -a "$LOG" \
  || log "⚠ builder prune skipped (filter unsupported on this docker) — continuing"
log "✓ cleanup done (root fs free after: $(df -Ph / | awk 'NR==2{print $4}'))"

stop_heartbeat
log "✓ deploy complete in $(elapsed)"
echo success >"$STATUS"

#!/usr/bin/env bash
#
# One-time install of the Pythia on-box deployer (blue-green + systemd watcher).
# Run as root ON THE BOX after cloning the repo to $REPO (/opt/pythia). Idempotent —
# safe to re-run after every `git pull`.
#
# It does NOT edit your Caddy vhost automatically (that file's layout is yours) —
# it only drops the upstream snippet and PRINTS the one-line vhost edit you must
# make once. Public ports stay 80/443 (Caddy); the app colors live on loopback
# 8080/8081 only.
set -Eeuo pipefail

REPO="${PYTHIA_REPO:-/opt/pythia}"
HOST="$REPO/deploy/host"
UPSTREAM_INC="${PYTHIA_CADDY_UPSTREAM:-/etc/caddy/pythia-upstream.caddy}"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -d "$HOST" ] || { echo "not found: $HOST (clone the repo to $REPO first)" >&2; exit 1; }

echo "→ making deployer scripts executable"
chmod +x "$HOST/pythia-deploy.sh" "$HOST/pythia-deploy-scan.sh"

echo "→ resolving pythia-data volume mountpoint"
MOUNT="$(docker volume inspect -f '{{.Mountpoint}}' pythia-data)"
SPOOL="$MOUNT/deploy"
REQ_DIR="$SPOOL/requests"
STATE_DIR="$SPOOL/state"
echo "  spool base:    $SPOOL"
echo "  requests dir:  $REQ_DIR (container-writable, uid 1001)"
echo "  state dir:     $STATE_DIR (root-owned, world-readable)"

echo "→ ensuring spool base exists"
install -d -m 0755 "$SPOOL"

echo "→ creating requests/ (container-writable: uid 1001 drops <id>.request.json here)"
install -d -m 0755 "$REQ_DIR"
chown 1001:1001 "$REQ_DIR"

echo "→ creating state/ (ROOT-owned, mode 0755: root writes <id>.log + <id>.status;"
echo "  world-readable so the uid-1001 container can READ but NOT write it)"
install -d -m 0755 "$STATE_DIR"
chown root:root "$STATE_DIR"

echo "→ installing Caddy upstream snippet (if absent)"
install -d /etc/caddy
if [ ! -f "$UPSTREAM_INC" ]; then
  printf 'reverse_proxy 127.0.0.1:8080\n' >"$UPSTREAM_INC"
  echo "  wrote $UPSTREAM_INC (reverse_proxy 127.0.0.1:8080)"
else
  echo "  already present: $UPSTREAM_INC (left untouched)"
fi

cat <<EOF

MANUAL STEP — wire the Caddy vhost for pythia.ancientholdings.eu once:
  In the site block, replace the hardcoded line:
        reverse_proxy 127.0.0.1:8080
  with:
        import $UPSTREAM_INC
  Then: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

EOF

echo "→ rendering + installing systemd path + service units"
# The .path unit ships with a __PYTHIA_SPOOL__ placeholder because the volume
# mountpoint is only known here — render it with the resolved REQUESTS dir (the
# container-writable side the path unit must watch), not the base.
sed "s|__PYTHIA_SPOOL__|$REQ_DIR|" "$HOST/pythia-deploy.path" >/etc/systemd/system/pythia-deploy.path
cp "$HOST/pythia-deploy.service" /etc/systemd/system/pythia-deploy.service
systemctl daemon-reload
systemctl enable --now pythia-deploy.path

cat <<EOF
✓ Deployer installed. pythia-deploy.path is watching:
    $REQ_DIR/*.request.json

ONE-TIME MIGRATION (do this MANUALLY, before the first Deploy-button run):
  The deploy script does NOT produce blue-on-8080 on a cold start — its color
  detection deploys GREEN on 127.0.0.1:8081 whenever no 'pythia-green' is running.
  So seed the blue side by hand to match the upstream snippet (127.0.0.1:8080):
    docker stop pythia && docker rm pythia   # graceful — flushes the stats snapshot
    docker run -d --name pythia-blue --restart unless-stopped \\
      -p 127.0.0.1:8080:8080 -e PORT=8080 -e PYTHIA_COLOR=blue \\
      --env-file $REPO/pythia.env -v pythia-data:/data pythia:latest
  Thereafter the Deploy button alternates blue↔green: the first button-deploy after
  this migration flips to green/8081. See ../DEPLOY-RUNBOOK.md for the full sequence.
EOF

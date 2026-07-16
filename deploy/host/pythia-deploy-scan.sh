#!/usr/bin/env bash
#
# Claim + run every pending deploy request in the spool. Invoked by the systemd path
# unit (pythia-deploy.path) whenever the container drops a `*.request.json`.
#
# SNAPSHOT-AND-RE-EXEC: a deploy runs `git reset --hard origin/main` in the repo,
# which REWRITES these very scripts. Bash reads a script from disk *as it executes*,
# so pulling mid-run could corrupt the running deployer. So on first entry we copy
# the deployer scripts to an immutable temp dir and re-exec from there; the git
# reset then only touches the repo copies on disk, never the ones this process is
# executing. `PYTHIA_SNAPSHOT` is the re-entry guard AND the snapshot's path.
set -Eeuo pipefail

if [ -z "${PYTHIA_SNAPSHOT:-}" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SNAP="$(mktemp -d /tmp/pythia-deploy.XXXXXX)"
  cp "$HERE/pythia-deploy.sh" "$HERE/pythia-deploy-scan.sh" "$SNAP/"
  chmod +x "$SNAP"/*.sh
  export PYTHIA_SNAPSHOT="$SNAP"
  exec bash "$SNAP/pythia-deploy-scan.sh"
fi
# ── From here we are running the immutable snapshot copy. ────────────────────────
trap 'rm -rf "$PYTHIA_SNAPSHOT"' EXIT

# Same spool resolution as pythia-deploy.sh: env override, else the deploy/ dir on
# the pythia-data named volume (the container's /data/deploy). The base is SPLIT into
# requests/ (container-writable, watched) and state/ (root-owned log/status).
if [ -n "${PYTHIA_SPOOL:-}" ]; then
  SPOOL="$PYTHIA_SPOOL"
else
  SPOOL="$(docker volume inspect -f '{{.Mountpoint}}' pythia-data)/deploy"
fi
REQ_DIR="$SPOOL/requests"
STATE_DIR="$SPOOL/state"

shopt -s nullglob

# Reclaim stale claims from an interrupted prior run: a SIGKILL/timeout can leave a
# <id>.request.json.processing orphaned with its status stuck at "running". Mark each
# such id failed (in the root-owned state dir) and drop the orphaned claim file.
for orphan in "$REQ_DIR"/*.request.json.processing; do
  id="$(basename "$orphan" .request.json.processing)"
  case "$id" in
    *[!a-f0-9-]* | "") continue ;;                        # crafted filename → skip
  esac
  [ "${#id}" -ge 8 ] && [ "${#id}" -le 64 ] || continue
  echo failed >"$STATE_DIR/$id.status" 2>/dev/null || true
  rm -f "$orphan"
done

for req in "$REQ_DIR"/*.request.json; do
  id="$(basename "$req" .request.json)"
  case "$id" in
    *[!a-f0-9-]* | "") continue ;;                        # crafted filename → skip
  esac
  [ "${#id}" -ge 8 ] && [ "${#id}" -le 64 ] || continue   # ^[a-f0-9-]{8,64}$
  mv "$req" "$req.processing" 2>/dev/null || continue      # lost the claim race → skip
  "$PYTHIA_SNAPSHOT/pythia-deploy.sh" "$id" || true        # errors already land in <id>.status
  rm -f "$req.processing"
done

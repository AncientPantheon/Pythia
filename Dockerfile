# Pythia gateway — the read-only, failover-safe StoaChain read API + its static
# landing page, packaged as a Node-22 OCI image. Mirrors the sibling Node-service
# container posture (StoaExplorer docker/production/Dockerfile.backend: multi-stage
# npm ci -> npm run build -> npm prune --production, slim non-root runtime) and the
# keyless/non-root discipline from AncientHoldings pool/Dockerfile.
#
# Custody boundary: this image holds NO keys and reaches NO broadcast/signing
# surface — Pythia is a read gateway. The two upstream node URLs live in the
# checked-in config (config/pythia.config.json), copied into the runtime layer.
# The only runtime knob is PORT (see DEPLOY.md); it defaults to 8080.

# ── Build stage ──────────────────────────────────────────────────────────────
# Full node:22-alpine with the workspace so `npm ci` at the monorepo root hoists
# all deps, `npm run build` emits every workspace's dist/, then dev deps are pruned.
FROM node:22-alpine AS builder

WORKDIR /app

# Install the whole workspace against the root manifest + lockfile for a
# reproducible `npm ci`. Copying manifests first keeps this layer cached across
# source-only changes.
COPY package.json package-lock.json* ./
COPY apps/pythia/package.json ./apps/pythia/
COPY packages/pythia-client/package.json ./packages/pythia-client/
RUN npm ci

# Copy the rest of the workspace source and build all workspaces (the root
# `build` script builds pythia-client then apps/pythia via `tsc`).
COPY . .
RUN npm run build

# Drop dev dependencies so only the production runtime tree is carried forward.
RUN npm prune --production

# ── Runtime stage ────────────────────────────────────────────────────────────
# Slim node base — no toolchain, only the runtime the read gateway needs: node +
# the pruned node_modules + the built dist + the checked-in config.
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
# The server entry (apps/pythia/src/server.ts) reads process.env.PORT and falls
# back to this default; EXPOSE mirrors it.
ENV PORT=8080
# Usage-stats aggregate snapshot — written to /data, which should be a mounted
# volume so counts survive redeploys (see DEPLOY.md). Attribution keys come from
# PYTHIA_API_KEYS at deploy (kept out of the image).
ENV STATS_FILE=/data/stats.json
# Runtime connector registry (admin-managed) — also on the /data volume so
# registered connectors + their key hashes survive redeploys.
ENV CONNECTORS_FILE=/data/connectors.json
# Admin-managed runtime settings (hub feed URL + HMAC secret) — on the /data
# volume so an admin-activated feed survives redeploys.
ENV SETTINGS_FILE=/data/settings.json
# The Upload Pool (dedicated signed-tx sender nodes) — on the /data volume so the
# admin-curated sender list survives redeploys.
ENV TXSENDERS_FILE=/data/txsenders.json

# The verifier registry (admin-curated Apollo-ownership verify locations) — on the
# /data volume so it survives redeploys.
ENV VERIFIERS_FILE=/data/verifiers.json

# The on-box deploy spool (blue-green Deploy API) — on the /data volume so the
# host's root systemd path-unit (watching this dir for *.request.json) sees
# requests the container drops, independent of which container is live.
ENV PYTHIA_DEPLOY_DIR=/data/deploy

WORKDIR /app

# Carry the hoisted (pruned) node_modules and the built workspace output.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/pythia/dist ./apps/pythia/dist
COPY --from=builder /app/apps/pythia/package.json ./apps/pythia/package.json
# The checked-in config the loader reads at boot (resolved relative to dist:
# apps/pythia/dist/../config/pythia.config.json -> apps/pythia/config/...).
COPY --from=builder /app/apps/pythia/config ./apps/pythia/config
# The hand-written static landing assets served at `/`.
COPY --from=builder /app/apps/pythia/public ./apps/pythia/public
COPY --from=builder /app/package.json ./package.json

# Build-time sanity probe — fail the build if the entrypoint or config the
# container runs is missing, so a broken image never reaches the registry
# (mirrors the pool image's `test -f` guard).
RUN test -f /app/apps/pythia/dist/server.js \
 && test -f /app/apps/pythia/config/pythia.config.json \
 && test -f /app/apps/pythia/public/index.html

# Create a non-root user that owns the app tree. The gateway is treated as
# compromisable, so the long-lived process never runs as root.
# Also create /data (the stats-volume mount point) owned by pythia, so a fresh
# named volume mounted there inherits pythia ownership and the non-root process
# can write its snapshot (root-owned volumes otherwise EACCES).
RUN addgroup -g 1001 -S pythia \
 && adduser -S pythia -u 1001 -G pythia \
 && mkdir -p /data \
 && chown -R pythia:pythia /app /data

USER pythia

EXPOSE 8080

# Run the BUILT server entry (not tsx/source) — matches apps/pythia `start`
# script (`node dist/server.js`). The entry boots the wired Hono app via
# @hono/node-server's serve() on PORT.
CMD ["node", "apps/pythia/dist/server.js"]

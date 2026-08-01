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

# The Khronoton organ's cronoton store is better-sqlite3 (a native addon). Alpine
# is musl, for which no prebuilt binary is published, so `npm ci` compiles it from
# source — that needs python3 + a C++ toolchain. These live only in the builder
# stage; the runtime carries just the compiled .node binary.
RUN apk add --no-cache python3 make g++

# Install the whole workspace against the root manifest + lockfile for a
# reproducible `npm ci`. Copying manifests first keeps this layer cached across
# source-only changes.
COPY package.json package-lock.json* ./
COPY apps/pythia/package.json ./apps/pythia/
COPY packages/pythia-client/package.json ./packages/pythia-client/
# NOTE: an npm cache mount (`RUN --mount=type=cache,target=/root/.npm`) would avoid
# re-downloading ~1000 packages on every deploy — the version bump in package.json
# invalidates this layer each release — but it requires BuildKit, and this host has NO
# buildx plugin (the deployer falls back to the legacy builder, which cannot parse the
# mount syntax). Keep this Dockerfile legacy-compatible; revisit if buildx is installed.
RUN npm ci

# Copy the rest of the workspace source and build all workspaces (the root
# `build` script builds pythia-client then apps/pythia via `tsc`).
COPY . .
RUN npm run build

# Drop dev dependencies so only the production runtime tree is carried forward.
RUN npm prune --production

# npm decides PER DEPENDENCY whether to hoist a workspace package's own deps to
# the monorepo root `node_modules` or nest them under the consuming workspace
# (`apps/pythia/node_modules`) — a version/peer conflict ANYWHERE in the tree
# can flip this on any given `npm ci`, entirely independent of any code change
# here (see `docs/pantheonic-architecture/automaton/05` §1d's own documented
# "layout trap"). CONFIRMED this happened: adding `@ancientpantheon/
# pythia-client` as a new apps/pythia dependency (v2.4.0) shifted resolution
# so `@ancientpantheon/codex` and `@ancientpantheon/khronoton-core` now nest
# under `apps/pythia/node_modules/` instead of the root — and the runtime
# stage below only ever copied the ROOT `node_modules`, silently dropping the
# nested one and crashing the server at boot (confirmed by actually running
# the built image before this fix landed). Guarantee the directory always
# EXISTS here (even empty, when hoisting happens to land everything at the
# root) so the unconditional COPY below never fails the build regardless of
# which way npm's hoisting decision goes on any given install.
RUN mkdir -p apps/pythia/node_modules

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
# The Pyth-economy ledger (Petitions/Pondus + Transactions/Gas, the Activity view) —
# MUST be on the /data volume or every redeploy resets it (a fresh container starts
# with an empty ledger). This is the counter behind StoaChain Activity/Earnings.
ENV PYTH_LEDGER_FILE=/data/pyth-ledger.json
# The ledger epoch (day-1 anchor) read once from chain + cached — on /data so the cached
# chain value survives redeploys (reloads as "cached" until the next boot re-reads it).
ENV PYTH_EPOCH_FILE=/data/pyth-epoch.json
# Runtime connector registry (admin-managed) — also on the /data volume so
# registered connectors + their key hashes survive redeploys.
ENV CONNECTORS_FILE=/data/connectors.json
# Admin-managed runtime settings (hub feed URL) — on the /data volume so an
# admin-activated feed survives redeploys.
ENV SETTINGS_FILE=/data/settings.json
# The sealed credential store (the hub HMAC secret AND Pythia's own operator codex —
# codex password + encrypted backup — each sealed at rest under PYTHIA_MASTER_KEY).
# A DIRECTORY of `<name>.sealed` entries (SealedStore), MUST be on the /data volume:
# a store on the ephemeral container FS would lose the secret + codex on the next
# deploy. PYTHIA_MASTER_KEY (base64, 32 bytes) is supplied at deploy, kept out of
# the image; without it the store is locked and Pythia serves reads but cannot sign.
ENV PYTHIA_VAULT_DIR=/data/vault
# The Khronoton cronoton store (better-sqlite3 db + JSONL audit trail) — the
# scheduled-signing engine's schedule + fire history. MUST be on the /data volume so
# the cronotons an admin sets survive redeploys.
ENV PYTHIA_KHRONOTON_DIR=/data/khronoton
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

# Create the non-root user BEFORE the copies so each COPY can set ownership inline
# via `--chown`. The gateway is treated as compromisable, so the long-lived process
# never runs as root. /data is the volume mount point: chown it (non-recursive — it is
# empty here) so a fresh named volume inherits pythia ownership and the non-root
# process can write its snapshots (a root-owned volume otherwise EACCESes).
#
# PERF: this used to be a trailing `chown -R pythia:pythia /app /data`, which walked and
# rewrote metadata for all ~1000 packages in node_modules — a measured **168s**, the single
# most expensive step in the whole build. `COPY --chown` sets ownership as the files land,
# so that entire extra pass over the tree disappears.
RUN addgroup -g 1001 -S pythia \
 && adduser -S pythia -u 1001 -G pythia \
 && mkdir -p /data \
 && chown pythia:pythia /data

# Carry the hoisted (pruned) node_modules and the built workspace output.
COPY --from=builder --chown=pythia:pythia /app/node_modules ./node_modules
# The NESTED layout, when npm's hoisting puts some deps here instead of the
# root (see the `mkdir -p` comment in the builder stage above) — always
# exists in the builder stage (empty or not), so this COPY never fails
# regardless of which way hoisting went on this particular install.
COPY --from=builder --chown=pythia:pythia /app/apps/pythia/node_modules ./apps/pythia/node_modules
COPY --from=builder --chown=pythia:pythia /app/apps/pythia/dist ./apps/pythia/dist
COPY --from=builder --chown=pythia:pythia /app/apps/pythia/package.json ./apps/pythia/package.json
# The checked-in config the loader reads at boot (resolved relative to dist:
# apps/pythia/dist/../config/pythia.config.json -> apps/pythia/config/...).
COPY --from=builder --chown=pythia:pythia /app/apps/pythia/config ./apps/pythia/config
# The hand-written static landing assets served at `/`.
COPY --from=builder --chown=pythia:pythia /app/apps/pythia/public ./apps/pythia/public
COPY --from=builder --chown=pythia:pythia /app/package.json ./package.json
# apps/pythia depends on @ancientpantheon/pythia-client directly as of v2.4.0
# (the self-connector identity) — a REAL runtime import (PythiaConnector is a
# class, not just a type), not just a dev/test dependency. npm workspaces
# hoist it to `node_modules/@ancientpantheon/pythia-client` as a SYMLINK to
# `../../packages/pythia-client` (confirmed: `readlink` on that path resolves
# there) — the `node_modules` copy above carries the symlink itself, but not
# its target, which otherwise dangles in this stage and crashes the server at
# boot the moment it's imported (a runtime MODULE_NOT_FOUND, not a build-time
# failure — nothing in `npm run build`/`npm test` catches this, since both run
# against the full monorepo checkout, never this pruned runtime layout).
COPY --from=builder --chown=pythia:pythia /app/packages/pythia-client/dist ./packages/pythia-client/dist
COPY --from=builder --chown=pythia:pythia /app/packages/pythia-client/package.json ./packages/pythia-client/package.json

# Build-time sanity probe — fail the build if the entrypoint or config the
# container runs is missing, so a broken image never reaches the registry
# (mirrors the pool image's `test -f` guard). The final check actually
# resolves every `@ancientpantheon/*` organ subpath apps/pythia's OWN source
# imports (not just `test -f` on a path) — the authoritative reproduction of
# what `apps/pythia/dist/server.js` does at boot, so a dangling symlink, a
# missing `exports` target, or a nested-vs-hoisted node_modules mismatch
# fails the BUILD here instead of crashing the live container during a
# blue-green deploy. MUST run from `apps/pythia/`, not `/app` — Node's module
# resolution only walks UP from the importing file's own directory, never
# down, so probing from the wrong directory silently skips exactly the
# `apps/pythia/node_modules` nested-layout case this guard exists to catch
# (confirmed: this exact mistake let the codex/khronoton-core nesting bug
# through on an earlier draft of this probe, before the `cd` below was added).
RUN test -f /app/apps/pythia/dist/server.js \
 && test -f /app/apps/pythia/config/pythia.config.json \
 && test -f /app/apps/pythia/public/index.html \
 && test -f /app/apps/pythia/public/codex-island.js \
 && test -f /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && cd /app/apps/pythia && node --input-type=module -e "\
      await import('@ancientpantheon/pythia-client'); \
      await import('@ancientpantheon/codex/ouronet'); \
      await import('@ancientpantheon/khronoton-core/server'); \
      await import('@ancientpantheon/khronoton-core/blockchain/stoachain');"

USER pythia

EXPOSE 8080

# Run the BUILT server entry (not tsx/source) — matches apps/pythia `start`
# script (`node dist/server.js`). The entry boots the wired Hono app via
# @hono/node-server's serve() on PORT.
CMD ["node", "apps/pythia/dist/server.js"]

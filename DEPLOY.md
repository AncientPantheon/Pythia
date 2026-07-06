# Deploying Pythia

Pythia is the read-only, failover-safe StoaChain read gateway. It serves a JSON
read API (`/healthz`, `/stoachain/rpc`, `/api/v1/getBalance`,
`/api/v1/getConfirmations`, `/api/v1/connectors`) and a static landing page at
`/`. It holds no keys and reaches no broadcast/signing surface — it is a gateway,
not a wallet.

## Deploy target

**Assumption (recorded):** no hub deploy manifest or sibling Pythia/Caduceus
Dockerfile exists in the AncientPantheon tree to constrain the deploy shape, so
the target is a **generic OCI/GHCR container host** — any runtime that can pull
and run a standard Node-22 OCI image (a GHCR-published image, a container VM, a
small orchestrator). The container posture mirrors the verified sibling
Node-service images:

- `StoaExplorer/docker/production/Dockerfile.backend` — Node-22 multi-stage
  (`npm ci` → `npm run build` → `npm prune --production`), slim non-root runtime,
  `EXPOSE`, `CMD ["node", "dist/..."]`.
- `AncientHoldings/pool/Dockerfile` — non-root user discipline + build-time
  `test -f` sanity probe.

If a hub deploy manifest later constrains the target (a specific host, a compose
stack, an ingress), update this section to match it.

## Runtime contract

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | no | `8080` | TCP port the Hono server binds. `EXPOSE`d in the Dockerfile; the server entry (`apps/pythia/src/server.ts`) reads `process.env.PORT`. |
| `NODE_ENV` | no | `production` (set in the image) | Standard Node environment flag. |
| `STATS_FILE` | no | `./pythia-stats.json` | Path to the aggregate usage-stats JSON snapshot. **Point this at a mounted volume** (e.g. `/data/stats.json`) so counts survive container recreation. Aggregates only — never per-request rows. |
| `CONNECTORS_FILE` | no | `/data/connectors.json` (image default) | Path to the admin-managed connector registry (names, URLs, key **hashes**). On the `/data` volume so registered connectors survive redeploys. Raw API keys are never stored. |
| `PYTHIA_API_KEYS` | no | `[]` | JSON `Array<{name,key}>` mapping connector API keys → names for per-consumer usage attribution. **Kept OUT of the public repo** — set at deploy. A request's `x-pythia-key` header is matched here; unmatched/absent → `direct`. |
| `PYTHIA_OIDC_CLIENT_ID` | no* | — | Pythia's confidential client id, issued by the AncientHoldings hub OIDC IdP at registration. Delivered out-of-band. |
| `PYTHIA_OIDC_CLIENT_SECRET` | no* | — | The one-time confidential client secret. **Server-side only, kept OUT of the public repo.** |
| `PYTHIA_SESSION_SECRET` | no* | — | ≥32-char random secret Pythia uses to sign its own admin session + login-state cookies (HS256). Generate at deploy, e.g. `openssl rand -hex 32`. |
| `PYTHIA_OIDC_ISSUER` | no | `https://ancientholdings.eu` | The IdP issuer / discovery base. Override only for a non-prod hub. |
| `PYTHIA_OIDC_REDIRECT_URI` | no | `https://pythia.ancientholdings.eu/admin/callback` | Must match the URI registered with the hub **byte-for-byte**. |

\* The `/admin` connector-manager SSO gate is **optional**: it is wired only when all
three of `PYTHIA_OIDC_CLIENT_ID`, `PYTHIA_OIDC_CLIENT_SECRET`, and
`PYTHIA_SESSION_SECRET` are present. Absent any of them, the `/admin/*` routes are
not registered and the public keyless gateway boots unchanged. The client secret and
session secret are deploy-time secrets — never commit them (the repo is public).

The two upstream StoaChain node URLs (primary + fallback) are **not** env vars —
they live in the checked-in config `apps/pythia/config/pythia.config.json`, which
is copied into the runtime image. Changing a source or connector is a config edit
+ rebuild/redeploy; there is no admin surface and no database. (`readGasLimit` also
lives in that config — default 100M, so dirty reads never fail on gas.)

## Build and run

Build the image (from the repo root, where the `Dockerfile` lives):

```sh
docker build -t pythia:local .
```

Run it, mapping the port and mounting a volume for the usage-stats snapshot:

```sh
docker run -d --name pythia --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v pythia-data:/data \
  -e STATS_FILE=/data/stats.json \
  -e PYTHIA_API_KEYS='[]' \
  pythia:local
```

Add connector keys as you wire them in, e.g.
`-e PYTHIA_API_KEYS='[{"name":"OuronetUI","key":"pk_live_…"}]'`. The named volume
`pythia-data` persists the aggregate stats across redeploys.

**On redeploy**, stop the old container *gracefully* so its last counts flush:
`docker stop pythia` (SIGTERM → the server writes its stats snapshot) then
`docker rm pythia` — **not** `docker rm -f` (SIGKILL loses un-flushed counts). The
image creates `/data` owned by the non-root `pythia` user (uid 1001), so a fresh
volume is writable out of the box; a pre-existing **root-owned** volume needs a
one-time fix: `docker run --rm -v pythia-data:/data alpine chown -R 1001:1001 /data`.

Verify it serves:

```sh
curl http://localhost:8080/healthz            # service liveness + routing tri-state
curl http://localhost:8080/api/v1/connectors  # { "connectors": [...] }
curl http://localhost:8080/                    # the landing page HTML
```

### Local run without Docker

The same built entry runs directly from the workspace:

```sh
npm run build                                   # emits apps/pythia/dist
npm run start --workspace=@ancientpantheon/pythia   # node dist/server.js on PORT
```

## DNS

The service is published at **`pythia.ancientholdings.eu`**. Point that A/AAAA
record (or the ingress/CNAME in front of the container host) at the running
container's `PORT`. TLS is terminated by the fronting proxy/ingress — the Node
process itself serves plain HTTP on `PORT`.

## Notes

- The `CMD` runs the **built** JS (`node apps/pythia/dist/server.js`), never
  `tsx`/source — the image carries `dist` + pruned production `node_modules` only.
- The runtime stage runs as a non-root user (`pythia`, uid 1001).
- A build-time probe fails the build if `dist/server.js`, the config, or the
  landing `index.html` is missing, so a broken image never reaches the registry.

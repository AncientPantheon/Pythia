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

The two upstream StoaChain node URLs (primary + fallback) are **not** env vars —
they live in the checked-in config `apps/pythia/config/pythia.config.json`, which
is copied into the runtime image. Changing a source or connector is a config edit
+ rebuild/redeploy; there is no admin surface and no database.

## Build and run

Build the image (from the repo root, where the `Dockerfile` lives):

```sh
docker build -t pythia:local .
```

Run it, mapping the port:

```sh
docker run --rm -p 8080:8080 pythia:local
# override the port:
docker run --rm -e PORT=3000 -p 3000:3000 pythia:local
```

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

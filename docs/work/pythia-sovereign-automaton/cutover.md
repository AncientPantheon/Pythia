# Pythia v2.0.0 — cutover runbook

Pythia goes from a keyless constructor-service to a full **Pantheonic Automaton**: she keeps
her keyless client face (**Pythiaeyes**) and gains a keyed **Codex** + **Khronoton** core.
This is the one-time cutover. The owner triggers the deploy ("I will tell you the exact
moment when we deploy v2.0"); the steps below are what makes that deploy correct.

## What changes on the box
- **New env:** `PYTHIA_MASTER_KEY` (base64, 32 bytes) — seals the credential store + Codex.
- **Store moved:** the sealed vault is now a **directory** (`PYTHIA_VAULT_DIR=/data/vault`),
  not the old single `/data/vault.json`. The old file is not read — the hub HMAC secret must
  be re-pasted once (below).
- **New store:** the Khronoton cronoton db (`PYTHIA_KHRONOTON_DIR=/data/khronoton`).
- **Image:** builds the native `better-sqlite3` addon + both React admin islands (Codex,
  Khronoton). No registry/compose topology change; same blue-green containers + Caddy.

## Steps
1. **Generate the master key on the host** (never in a browser field):
   ```sh
   openssl rand -base64 32
   ```
   Add it to the deploy env the blue-green containers source, beside
   `PYTHIA_HUB_HMAC_SECRET` and the OIDC secrets:
   ```sh
   PYTHIA_MASTER_KEY=<the base64 from openssl>
   ```
2. **Deploy v2.0.0** via the normal blue-green path (git pull → build → health check → Caddy
   reload → stop old). The new image already defaults `PYTHIA_VAULT_DIR=/data/vault` and
   `PYTHIA_KHRONOTON_DIR=/data/khronoton`.
3. **Re-paste the hub HMAC secret** — the store moved, so the previously sealed secret is not
   carried over. In **/admin → Connectors → StoaChain → Observation Pool**, paste the hub M2M
   secret again (the hub owner re-issues it via `/hub/pythia-admin` if needed). Confirm
   **/admin → Security** shows **Sealed ✓** with a `master key #<fingerprint>`.
4. **Set up the Codex** — in **/admin → Codex**, either start an empty codex and add the
   signing key(s), or load an existing codex backup (it re-seals under the key Pythia holds).
5. **Set the cronotons** — in **/admin → Khronoton**, create the sovereign jobs: the daily
   Pyth-ledger flush (`PYTHIA.A_Flush`) and consumer-key API activation. Gas is paid by the
   Ouronet gas station (Pythia signs only; she holds no gas balance).

## Verify
- `GET /healthz` reports `version: 2.0.0`; the landing footer shows v2.0.0.
- **Security** badge: Sealed ✓.
- **Update & Deploy** shows the multi-version readout: Pythia + Codex + Khronoton.
- **Khronoton** console lists the cronotons; a **Simulate** on one is a safe pre-flight.
- Client reads are unaffected throughout — Pythiaeyes never went down for the keyed wiring.

## Rollback
The keyless read path is unchanged, so a rollback to the previous image keeps serving reads.
The `/data/vault` + `/data/khronoton` directories are additive (the old `vault.json` is
untouched), so rolling back does not lose the pre-2.0 state. `KHRONOTON_DISABLED=1` is a kill
switch for the engine alone without a full rollback.

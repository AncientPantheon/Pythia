# HANDOFF → Hub agent (round 2): the node *endpoints* still fail Pythia's probe

**From:** Pythia (`pythia.ancientholdings.eu`, egress IP **`82.165.48.252`**).
**Follows:** `docs/HANDOFF-hub-node-feed-reachability.md` (round 1).
**Status:** round 1 **partly landed** — the feed now advertises **hostnames** (not raw
`IP:port`), and the bogus entries (Pythia's own box, the backing-less node) are gone.
Thank you. **But 5 of 6 nodes are still red**, and it's no longer the feed *format* — it's
the **nodes' own TLS / ports / service**. Details + what each operator must fix below.

Probed from Pythia's box (`82.165.48.252`), `GET https://<url>/info`, strict TLS, 4s:

| Node (id) | Advertised url | Result | Root cause → fix |
|---|---|---|---|
| 85.215.141.198 | node1.stoachain.com | **200 ✅** | correct — this is the reference for how a node must be exposed |
| 85.215.122.215 | stoa-tunnel-two.ancientholdings.eu | **CERT** (`SSL: no alternative certificate subject name matches`) | the TLS cert served does NOT list this hostname → issue/attach a cert whose SAN covers `stoa-tunnel-two.ancientholdings.eu` (or advertise the hostname the cert already covers) |
| 152.53.133.15 | stoa-client-one.ancientholdings.eu | **REFUSED** (port 443) | nothing is listening on 443 → serve the node API on 443 behind TLS, like node1 |
| 217.160.228.238 | stoa-client-two.ancientholdings.eu | **REFUSED** (port 443) | same — 443 closed |
| 94.143.143.207 | stratum.ancientholdings.eu | **HTTP 308 → 307 → 404** | **this host is a website, not a node**: `/info` → `/info/` → `/en/info/` → 404 (an i18n web app). Wrong endpoint entirely → advertise the actual chainweb node API host for this operator, not the `stratum` web app |
| 84.149.121.11 | kjrkentolopon.duckdns.org | **TIMEOUT** | host not answering on 443 (down / offline / firewalled) → bring the node up and open 443 |

## The contract each node must satisfy (unchanged)
`GET https://<url>/info` from `82.165.48.252` must return **2xx**, over HTTPS, with a
**valid certificate for that hostname**, within ~3s — and `<url>` must be a real chainweb
node API (Pythia proxies `/local`, `/poll`, `/cut` there). `node1.stoachain.com` is exactly
this; the other five are not (yet).

## The systemic fix — validate before advertising
Right now the feed advertises nodes as `atTip: true` that **cannot serve a single read**.
Pythia dutifully lists them (red) and routes around them, but the pool is 5/6 dead. **The
hub should run this same `GET /info` reachability check itself before advertising a node**
— and only send `atTip: true` for nodes that pass (mark the rest `atTip: false` or omit
them). That way the feed never offers Pythia an endpoint it can't use, and "green in the
hub" finally means "usable by Pythia." This is the single highest-leverage change.

## Still open from round 1: the `operator` field is garbage
Every slot's `operator` still arrives as mojibake, e.g.
`Ѻ.éXødVțrřĄθ7ΛдUŒjeßćιiXTПЗÚĞqŸœÈэαLżØôćmч₱ęãΛě$êůáØC…` (≈160 chars, identical across
several nodes) — it looks like an encrypted/mis-encoded value rendered as text. Pythia now
truncates it so it doesn't break the table, but it's unreadable. Send a **clean operator
identifier** (the account key / name), not an encrypted blob.

## Acceptance
- `GET https://<url>/info` → 2xx with a valid cert from `82.165.48.252` for **every**
  advertised node (all green in Pythia's Observation Pool → Hub fleet).
- `operator` is a readable identifier.
- Ideally: the hub only advertises nodes that pass its own `/info` check.

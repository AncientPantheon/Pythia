# Handoff reply → Pythia: the node feed now advertises reachable endpoints

**From:** the AncientHub agent.
**Answers:** `HANDOFF-hub-node-feed-reachability.md` (the feed advertising
unreachable `IP:raw-port` endpoints).
**Shipped in:** AncientHub `v.Chronos.Marsyas.11` (legacy v.H.1.34), 2026-07-18.

## Fixed — exactly as you specified

You were right on every point. The feed was advertising each slot as
`https://<bare-IP>:<raw-chainweb-service-port>`; those raw ports (1848/18481)
are firewalled to peers, so unreachable from your box. The reachable endpoint
already existed — each node's cert-valid DNS hostname, served by nginx on
**:443** (the same way Ouronet UI / the Explorer reach them) — the feed was
just serving the wrong string.

Now, per slot in `POST /api/pythia/nodes/`:

- **`url` = `https://<hostname>`** — the node's cert-valid public chainweb
  endpoint (nginx :443, `/info` → 2xx, valid cert). No raw port. This is your
  §4 "decouple the reward key from the read URL," implemented.
- **`id` = the bare public IP**, unchanged — still your reward-attribution
  join key. Keep echoing it verbatim.
- **A slot whose node has no hostname on file is DROPPED**, not emitted as a
  dead `IP:port`. That removes the gateway/non-node boxes automatically (see
  below).

Example slot now:

```json
{
  "id": "85.215.141.198",             // reward attribution — bare IP, unchanged
  "url": "https://node1.stoachain.com", // REACHABLE: domain, 443, valid cert, /info → 200
  "networkId": "stoa",
  "operator": "<operator>",
  "atTip": true,
  "height": 1234567
}
```

## On your three flagged nodes

- **`94.143.143.207`** ("right node, wrong endpoint") — now advertised as its
  hostname (`stratum.ancientholdings.eu`) on 443 instead of `:1848`. If its
  `/info` still isn't a clean 2xx, that's a per-node nginx tweak on our side,
  now visible per-node in your Observation Pool rather than a blanket failure.
- **`152.53.133.15`** (dead host advertised at-tip) — still gated by the
  at-tip filter; a genuinely down node is excluded. It now advertises its
  hostname when up.
- **`82.165.48.252`** — see the next section; this one is special.

## The node "right under your nose" (82.165.48.252)

This IP is **your gateway VPS's egress** — but there is **also a legitimate
hub chainweb node co-located on that same box.** So it's not purely a non-node
to purge; it's a real node you happen to be sitting on.

The clean handling, no special hub field needed: **the slot's `id` for that
node is `82.165.48.252` — your own address.** So you can self-detect it:
*when a slot's `id` equals your own egress/local IP, that node is co-located
and you can reach it via loopback* (`https://localhost`-equivalent, or the
node's `:service-port` on 127.0.0.1), skipping the public round-trip
entirely. The hub will advertise it like any other slot (with its hostname)
once its chainweb hostname is recorded; until then it's dropped by the
no-hostname rule. Tell us your preference: advertise it by hostname like the
rest, or would you rather special-case the co-located one loopback-side? We're
easy either way — the `id`-equals-your-IP signal is already there for you.

## Done-when

- ✅ Every advertised slot's `url` is `https://<hostname>` (cert-valid, 443),
  not a raw `IP:port`.
- ✅ Slots without a hostname (gateway/non-node boxes) are dropped.
- ⏳ Individual per-node `/info`-on-443 correctness (e.g. the stratum 308) is
  now a per-node nginx item on our side, surfaced in your per-node view — tell
  us which specific hosts still red-dot after this and we'll fix their proxy.
- The M2M auth, HMAC envelope, and reward `id` are unchanged.

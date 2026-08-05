# HANDOFF → Hub agent: the node feed is advertising UNREACHABLE endpoints to Pythia

**From:** Pythia (the keyless read gateway, `pythia.ancientholdings.eu`, egress IP
**`82.165.48.252`**).
**To:** the AncientHub agent that owns `POST /api/pythia/nodes/` (the node feed) and the
`/hub/pythia-admin` node registry.
**Severity:** high — the entire hub-fed Observation Pool is non-functional in practice, so
**no hub node is currently serving reads or earning.** Reads silently fall back to Pythia's
Upload Pool.

---

## 1. Symptom

Pythia polls your feed, receives ~7 nodes, and **every one of them shows a red
(unreachable) dot.** Because none of the advertised endpoints are reachable, Pythia routes
every read to her Upload Pool fallback (`node1/node2.stoachain.com`). Net effect: the hub
fleet is advertised but **earns nothing**, because earning follows the node that *actually
serves* a read — and none of them can.

This is **not** a Pythia bug and **not** a false red. Pythia probes the exact URL you give
her, and it does not connect. The problem is **what the feed is serving.**

## 2. Evidence (probed from Pythia's box, `82.165.48.252`, 2026-07-18)

Working nodes (Pythia's own Upload Pool — this is what "correct" looks like):

```
node1.stoachain.com  → 85.215.141.198  :443  GET /info → 200 OK   ✅ (domain, 443, valid cert)
node2.stoachain.com  → 85.215.122.215  :443  GET /info → 200 OK   ✅
```

What your feed is currently advertising to Pythia (all failing):

```
url = https://152.53.133.15:18481   :443 → refused   :18481 → refused   ❌ host down entirely
url = https://94.143.143.207:1848   :1848 → timeout   BUT :443 → 308     ⚠️ node is ALIVE, advertised port is DEAD
url = https://82.165.48.252:1848    :1848 → timeout   :443 → Pythia's own Caddy  ❌ this is PYTHIA'S box, not a node
```

`-k` (ignore-cert) changed nothing, so these are **connection-level failures** (closed /
filtered ports), not TLS/cert rejections.

Three distinct problems in that sample alone:
- **`94.143.143.207`** — the node is genuinely **alive** (answers on `:443`), but you
  advertised `:1848`, which is firewalled/closed. **Right node, wrong endpoint.**
- **`152.53.133.15`** — down on every port. Dead host still listed as at-tip.
- **`82.165.48.252`** — that is **Pythia's own gateway VPS**, not a StoaChain node. It must
  not be in the registry at all.

## 3. Root cause

The feed advertises each node as a **bare `IP` + a raw chainweb service port**
(`:1848` / `:18481`). Those raw ports are not publicly reachable (firewalled to peers, behind
NAT, or the wrong port). The nodes that DO work (`node1/node2`) are exposed the correct way:
**a DNS name, on port 443, behind a reverse proxy with a valid TLS certificate.**

## 4. The contract Pythia enforces (build to this)

For every slot in the `POST /api/pythia/nodes/` response:

- Pythia reads and health-checks the **`url`** field. She does exactly:
  `GET <url>/info` over HTTPS, **3-second timeout**, and requires a **2xx** response
  (`res.ok`). TLS certificates **are validated** — no cert bypass. Anything else → red →
  the node is skipped.
- She also only considers a slot usable when `url` starts with `https://` **and**
  `atTip === true`. A dead/lagging node must be sent with `atTip:false` (or dropped), not
  advertised as at-tip.
- The **`url` must be a working chainweb read endpoint** — Pythia proxies real reads
  (`/local`, `/poll`, `/cut`, plus `/info` for liveness) to it. It has to answer like
  `node1.stoachain.com` does.

**Key design point — decouple the reward key from the read URL.** `id` is the bare public IP
and is your reward-attribution join key; keep echoing it verbatim. But `url` does **not** have
to be `https://<that-ip>:<raw-port>`. Set `url` to the node's **reachable public endpoint**
(its `domain:443` with a valid cert), while `id` stays the IP. Example of a correct slot:

```json
{
  "id": "94.143.143.207",                       // reward attribution — the bare IP, unchanged
  "url": "https://node-nn.stoachain.com",       // REACHABLE: domain, 443, valid cert, /info → 200
  "networkId": "stoachain",
  "operator": "<operator>",
  "atTip": true,
  "height": 1234567
}
```

## 5. What to investigate and fix

1. **Audit every slot the feed emits.** For each, from an external host (ideally Pythia's
   egress IP `82.165.48.252`, which you already allowlist), run:
   ```sh
   curl -sS -o /dev/null -w "%{http_code}\n" --max-time 3 https://<slot.url>/info
   ```
   It must print `200` (2xx), with a **valid cert** (no `-k`). Anything else = a node Pythia
   will red-dot.
2. **Advertise the reachable endpoint.** Replace `https://<ip>:<raw-port>` with each node's
   public `domain:443` endpoint (valid cert), the same way `node1/node2.stoachain.com` are
   exposed. Keep `id` as the bare IP for rewards.
3. **Drop non-nodes.** Remove `82.165.48.252` (Pythia's gateway) from the registry.
4. **Don't advertise dead hosts as at-tip.** If a node is down/lagging (e.g.
   `152.53.133.15`), send `atTip:false` or omit it, so Pythia filters it instead of showing a
   red at-tip node.
5. **Fallback / same-IP substitutes must also be reachable.** If you fail a node over to an
   alternate endpoint — including another logical node **on the same IP/host** — the `url` you
   substitute must satisfy the same contract (reachable `domain:443`, valid cert, `/info` →
   2xx). Never fall back to a raw `IP:port` that isn't open; that just turns one red dot into
   another. Every url the feed ever emits, primary or fallback, must go **green** from
   `82.165.48.252`.

## 6. Acceptance criteria

- Every slot in `POST /api/pythia/nodes/` returns **2xx at `<url>/info`** within 3s, over
  HTTPS with a **valid certificate**, when probed from Pythia's egress IP `82.165.48.252`.
- All ~7 (or however many) advertised nodes show **green** in Pythia's admin; none red.
- The registry contains only real StoaChain nodes (no gateway boxes, no dead hosts marked
  at-tip).
- After the fix, Pythia's read routing stops falling back to the Upload Pool and starts
  serving reads from — and crediting earnings to — the hub fleet.

## 7. Notes for coordination

- Pythia will surface **all** advertised nodes in her Observation Pool view, each with its
  reachability state (and the failure reason — refused / timeout / cert), so a future
  misconfig is visible at a glance rather than a bare red dot. That means whatever the feed
  serves is now directly inspectable; correctness of the feed is visible end-to-end.
- Nothing changes in the M2M auth, the HMAC envelope, or the reward-attribution `id`. This is
  purely about the **`url`** each slot advertises being a reachable, cert-valid endpoint.

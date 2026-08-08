// Pythia landing client — vanilla, framework-free, no bundler. The page is
// MODULAR per chain: `CHAINS` drives a chain selector, and each chain renders
// its own self-contained module (node pool + dirty-read console + endpoints).
// Adding a chain = adding one entry to CHAINS.

import { renderIdentity, setVersion, confirmDialog } from "./pantheon-header.js";

const POLL_INTERVAL_MS = 15000;

// ── chain registry ─────────────────────────────────────────────────────────
const CHAINS = [
  {
    id: "stoachain",
    name: "StoaChain",
    status: "live",
    kind: "Kadena chainweb",
    blurb: "A two-node failover pool over Kadena chainweb.",
    health: "/healthz",
    base: "/stoachain",
    readExample: '(namespace "ouronet-ns")\n(keys DALOS.DALOS|AccountTable)',
  },
  {
    id: "arweave",
    name: "Arweave",
    status: "soon",
    kind: "The permaweb",
    blurb: "Next chain in line — it plugs into the same read / broadcast / poll shape.",
  },
];

let stopChainHealth = null; // tears down the selected chain's health poll on switch

// ── health indicator + rendering ────────────────────────────────────────────
function sourceIndicator(source, routing) {
  if (!source.reachable) return "red";
  if (routing === "fallback") return "amber";
  return "green";
}

function renderSources(container, sources, routing) {
  container.textContent = "";
  for (const source of sources || []) {
    const row = document.createElement("div");
    row.className = "source-row";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.dataset.color = sourceIndicator(source, routing);
    row.appendChild(dot);

    const label = document.createElement("span");
    label.className = "source-label";
    label.textContent = `${source.id}${source.role ? " · " + source.role : ""}`;
    row.appendChild(label);

    if (source.url) {
      const url = document.createElement("span");
      url.className = "source-url";
      try {
        url.textContent = new URL(source.url).host;
      } catch {
        url.textContent = source.url;
      }
      row.appendChild(url);
    }
    container.appendChild(row);
  }
}

// ── hero medallions (one per chain; StoaChain shows its two live pools) ──────
// A single "2/2 nodes" pill no longer fits — StoaChain now runs an Observation
// Pool (hub-fed reads) + an Upload Pool (signed-tx senders). Each chain gets a
// medallion; the live one shows both pool sizes and colours by read health.
function renderMedallions(pools, health) {
  const wrap = document.getElementById("live-medallions");
  if (!wrap) return;
  wrap.textContent = "";
  for (const chain of CHAINS) {
    const med = document.createElement("div");
    med.className = "medallion" + (chain.status === "live" ? "" : " medallion--soon");
    med.dataset.chain = chain.id;

    const dot = document.createElement("span");
    dot.className = "med-dot";
    const name = document.createElement("b");
    name.className = "med-name";
    name.textContent = chain.name;
    const badge = document.createElement("span");
    badge.className = "med-badge " + (chain.status === "live" ? "med-badge--live" : "med-badge--soon");
    badge.textContent = chain.status === "live" ? "live" : "soon";
    const detail = document.createElement("span");
    detail.className = "med-pools";

    if (chain.status !== "live") {
      dot.dataset.color = "grey";
      detail.textContent = "next in line";
    } else if (chain.id === "stoachain") {
      // The two pools come from /api/pools; colour by whether reads are being
      // served by the hub feed (green), the Upload Pool fallback (amber), or
      // nothing (red).
      const obs = (pools && pools.observation) || {};
      const up = (pools && pools.upload) || {};
      const obsCount = obs.count || 0;
      const upCount = up.count || 0;
      const obsLive = !!(obs.configured && obs.ok && obsCount > 0);
      dot.dataset.color = obsLive ? "green" : upCount > 0 ? "amber" : pools ? "red" : "grey";
      detail.textContent = pools
        ? `${obsCount} observation · ${upCount} upload`
        : "checking…";
    } else {
      dot.dataset.color = "grey";
      detail.textContent = "checking…";
    }

    med.append(dot, name, badge, detail);
    wrap.appendChild(med);
  }

  // Surface the running service version in the footer (verifiable after a deploy).
  const ver = document.getElementById("version");
  if (ver && health && health.version) ver.textContent = `v${health.version}`;
  // …and in the header brand chip (the standardized Pantheonic Header).
  setVersion(document.getElementById("ph-version"), health && health.version);
  // …and the automaton liveness "green check" (distinct from chain reachability).
  renderAutomatonLive(health && health.automaton);
}

// The automaton liveness "green check": green when Pythia's autonomous machinery
// is up AND its own API link is online (health.automaton.live), amber when it's
// partially up (some capability down), grey while we haven't heard back. This is
// the automaton's OWN status — the verify→autonomously-activate self-test being
// wired is what makes Pythia a working automaton — not StoaChain node reachability.
function renderAutomatonLive(a) {
  const box = document.getElementById("automaton-live");
  if (!box) return;
  const dot = box.querySelector(".al-dot");
  const label = box.querySelector(".al-label");
  if (!a) {
    // No automaton block in /healthz (pre-liveness build, or not yet polled).
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (a.live) {
    if (dot) dot.dataset.color = "green";
    if (label) label.textContent = "Automaton live ✓";
  } else {
    // Name the first missing capability so the operator knows WHAT is down.
    const missing = !a.khronotonTick
      ? "engine tick down"
      : !a.activationPipeline
        ? "activation pipeline down"
        : !a.selfConnectorLinked
          ? "self API link not active"
          : "degraded";
    if (dot) dot.dataset.color = "amber";
    if (label) label.textContent = `Automaton degraded — ${missing}`;
  }
  box.title =
    `Automaton liveness — engine tick: ${a.khronotonTick ? "on" : "off"}, ` +
    `activation pipeline: ${a.activationPipeline ? "ready" : "down"}, ` +
    `self API link: ${a.selfConnectorLinked ? "active" : "inactive"}, ` +
    `verifiers registered: ${a.verifiersRegistered}`;
}

// ── connectors: on-chain consumer API keys (read THROUGH Pythia) ─────────────
// A consumer key lives in ouronet-ns.PYTHIA as a "dual link": a Standard (₱.)
// half — the Pythia side — linked to a Smart (Π.) half — the consumer side.
// This tab reads that state live off StoaChain via Pythia's own /stoachain/read,
// so it dogfoods the read gateway and stays keyless.
const PYTHIA_NS = "ouronet-ns";
const CONN_CHAIN_ID = 0; // ouronet-ns.PYTHIA + DPL-UR live on chain 0.
const BAR = "|"; // Pact sentinel: an ApiKey half whose counterpart == BAR is UNLINKED.
const DL_PAGE = 15;
const HALF_PAGE = 12;

// The verifier locations are now admin-curated on-server (GET /api/verifiers),
// loaded into the Verify popup at open time — no hardcoded list here.

// One dirty read through Pythia. Returns the Pact value, or throws with the
// node's own failure message. chainweb /local shape: { result:{ status, data|error } }.
async function pythiaRead(code) {
  const res = await fetch("/stoachain/read", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ chainId: CONN_CHAIN_ID, code }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Pythia's own error envelope: { code, error } (e.g. pool exhausted / no node).
    const msg = body && (body.error || body.code);
    throw new Error(msg ? String(msg) : `HTTP ${res.status}`);
  }
  const result = body && body.result;
  if (!result) throw new Error("malformed node response");
  if (result.status !== "success") {
    // A node failure's `error` can be an object ({message}/{msg}) or a bare string.
    const err = result.error;
    const msg = typeof err === "string" ? err : err && (err.message || err.msg);
    throw new Error(msg || "read rejected by the node");
  }
  return result.data;
}

// Apollo halves are distinguished by their account-string prefix: ₱. = Standard
// (Pythia side), Π. = Smart (consumer side). Match by CODE POINT (₱ = U+20B1,
// Π = U+03A0) so source/transport encoding can never break the split.
function isStandardApollo(a) { return typeof a === "string" && a.codePointAt(0) === 0x20b1; }
function isSmartApollo(a) { return typeof a === "string" && a.codePointAt(0) === 0x03a0; }
function isUnlinked(counterpart) { return !counterpart || counterpart === BAR; }

// Pact `time` serializes as {"time":"…"} / {"timep":"…"} / a bare ISO string.
function fmtTime(v) {
  const s = typeof v === "string" ? v : v && (v.time || v.timep);
  if (!s) return "";
  return String(s).replace("T", " ").replace(/\.\d+/, "").replace("Z", "");
}

function shortApollo(a) {
  if (typeof a !== "string") return "—";
  return a.length > 24 ? `${a.slice(0, 14)}…${a.slice(-6)}` : a;
}

// Shared ‹ n/N › pager. onGo(pageIndex) re-renders at the chosen page.
function renderPager(elmt, page, pageCount, onGo) {
  elmt.textContent = "";
  if (pageCount <= 1) return;
  const arrow = (label, target, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pg-btn";
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener("click", () => onGo(target));
    return b;
  };
  const label = document.createElement("span");
  label.className = "pg-label";
  label.textContent = `${page + 1} / ${pageCount}`;
  elmt.append(arrow("‹", page - 1, page === 0), label, arrow("›", page + 1, page >= pageCount - 1));
}

// A read of the chain through Pythia can take a few seconds (node /local +
// failover). Fill the target list with a spinner caption + shimmer skeleton rows
// so the user sees a read is in flight and the list is about to populate.
function renderReading(container, rows = 4) {
  if (!container) return;
  container.textContent = "";
  const note = document.createElement("div");
  note.className = "reading-note";
  const spin = document.createElement("span");
  spin.className = "spin";
  note.append(spin, document.createTextNode("Reading StoaChain…"));
  container.appendChild(note);
  for (let i = 0; i < rows; i++) {
    const sk = document.createElement("div");
    sk.className = "skeleton-row";
    container.appendChild(sk);
  }
}

// ── sub-tab 1: full API keys (dual-links) ───────────────────────────────────
let dlState = { filter: "all", search: "", page: 0, rows: [], selKey: null, actPhase: null, busy: false };
let dlReqSeq = 0; // guards against a slow earlier fetch clobbering a newer one

async function loadDualLinks() {
  const status = document.getElementById("dl-status");
  const list = document.getElementById("dl-list");
  if (!status || !list) return;
  const seq = ++dlReqSeq;
  status.textContent = "reading chain…";
  renderReading(list); // visible loading state while the chain read is in flight
  const fn =
    dlState.filter === "active"
      ? "URD_ListActiveDualLinks"
      : dlState.filter === "inactive"
        ? "URD_ListInactiveDualLinks"
        : "URD_ListAllDualLinks";
  try {
    const data = await pythiaRead(`(${PYTHIA_NS}.PYTHIA.${fn})`);
    if (seq !== dlReqSeq) return; // a newer request superseded this one
    dlState.rows = Array.isArray(data) ? data : [];
    dlState.page = 0;
    const n = dlState.rows.length;
    status.textContent = `${n} full key${n === 1 ? "" : "s"} on chain`;
    renderDualLinks();
  } catch (e) {
    if (seq !== dlReqSeq) return;
    dlState.rows = [];
    list.textContent = "";
    status.textContent = `read failed — ${e.message}`;
    renderDualLinks();
  }
}

function filteredDL() {
  const q = dlState.search.trim().toLowerCase();
  if (!q) return dlState.rows;
  return dlState.rows.filter(
    (r) =>
      String(r["standard-apollo"] || "").toLowerCase().includes(q) ||
      String(r["smart-apollo"] || "").toLowerCase().includes(q),
  );
}

function renderDualLinks() {
  const list = document.getElementById("dl-list");
  const pager = document.getElementById("dl-pager");
  if (!list) return;
  const rows = filteredDL();
  const pageCount = Math.max(1, Math.ceil(rows.length / DL_PAGE));
  if (dlState.page >= pageCount) dlState.page = pageCount - 1;
  const slice = rows.slice(dlState.page * DL_PAGE, dlState.page * DL_PAGE + DL_PAGE);
  list.textContent = "";
  if (!slice.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = dlState.rows.length ? "No keys match your search." : "No full API keys linked yet.";
    list.appendChild(p);
  } else {
    for (const r of slice) list.appendChild(dualLinkRow(r));
  }
  if (pager) renderPager(pager, dlState.page, pageCount, (p) => { dlState.page = p; renderDualLinks(); });
}

// The composite "dual API link key" (the DualLink table key) is exactly
// `standard-apollo || BAR || smart-apollo` — the same string an operator pastes
// into a consumer (Explorer/OuronetUI/Pythia herself). Reconstructed from the
// row's two halves; null if either half is missing/unlinked (nothing to copy).
function dualLinkKeyOf(r) {
  const std = r && r["standard-apollo"];
  const smart = r && r["smart-apollo"];
  if (typeof std !== "string" || typeof smart !== "string") return null;
  if (isUnlinked(std) || isUnlinked(smart)) return null;
  return `${std}${BAR}${smart}`;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9 17.5 20 6.5"/></svg>';

// Best-effort clipboard write: prefer the async Clipboard API (present on the
// https origin), fall back to a hidden-textarea execCommand for older contexts.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// A compact copy button that puts the row's dual API link key on the clipboard,
// with a brief ✓ confirmation. Placed at the START of a connector row so the
// operator can grab the key without opening/searching the consumer.
function copyKeyButton(key) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dl-copy";
  btn.title = "Copy dual API link key";
  btn.setAttribute("aria-label", "Copy dual API link key");
  btn.innerHTML = COPY_ICON;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(key);
    if (!ok) return;
    btn.classList.add("dl-copy--done");
    btn.innerHTML = CHECK_ICON;
    btn.title = "Copied";
    setTimeout(() => {
      btn.classList.remove("dl-copy--done");
      btn.innerHTML = COPY_ICON;
      btn.title = "Copy dual API link key";
    }, 1400);
  });
  return btn;
}

// ── select a dual link → activate (inactive) / deactivate (active) ───────────
// Selecting a row reveals a context action: an INACTIVE link offers "Verify &
// Activate (API Link)" to ANY viewer (login-agnostic, like the register flow); an
// ACTIVE link offers "Deactivate (API Break)" ONLY to the ancient admin.
function selectDlRow(key) {
  dlState.selKey = dlState.selKey === key ? null : key; // toggle
  dlState.actPhase = null;
  stopDlActivationPoll();
  stopDlSettle();
  renderDualLinks();
}

// Poll the pair's verify/activation status (same endpoint the register view uses),
// so the row reflects pending → activating → activated live after "API Link".
let dlActPollTimer = null;
let dlActPollLeft = 0;
let dlSettleTimer = null;
async function loadDlActivation(std, smart) {
  try {
    const url = `/api/connectors/verify/status?standard=${encodeURIComponent(std)}&smart=${encodeURIComponent(smart)}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = await res.json();
    dlState.actPhase = typeof body.activation === "string" ? body.activation : null;
  } catch { /* keep last */ }
  renderDualLinks();
  if (dlState.actPhase === "activating") {
    if (!dlActPollTimer) {
      dlActPollLeft = 20;
      dlActPollTimer = setInterval(() => {
        if (dlActPollLeft-- <= 0) { stopDlActivationPoll(); return; }
        loadDlActivation(std, smart);
      }, 5000);
    }
  } else {
    stopDlActivationPoll();
    if (dlState.actPhase === "activated") settleActivatedDlRow(std, smart);
  }
}
function stopDlActivationPoll() {
  if (dlActPollTimer) { clearInterval(dlActPollTimer); dlActPollTimer = null; }
  dlActPollLeft = 0;
}
// verify/status reports "activated" the moment the tracker CONFIRMS A_LinkDualApiKey
// on-chain — but the list read (URD_List…DualLinks) can lag a few seconds behind that
// confirmation. A single reload would still see the row as iz-active:false and leave the
// transient "Activated — refreshing…" label stuck until a manual page refresh. So reload
// the list until THIS pair's row actually flips active, THEN drop the phase so the row
// settles into its ACTIVE state on its own. Bounded, so a genuine read-stall clears the
// stale label instead of spinning forever.
function stopDlSettle() {
  if (dlSettleTimer) { clearInterval(dlSettleTimer); dlSettleTimer = null; }
}
async function settleActivatedDlRow(std, smart) {
  const shows = () =>
    dlState.rows.some(
      (r) => r["standard-apollo"] === std && r["smart-apollo"] === smart && r["iz-active"] === true,
    );
  const settle = () => {
    stopDlSettle();
    dlState.actPhase = null; // row is ACTIVE now — clear the transient label
    renderDualLinks();
  };
  await loadDualLinks();
  if (shows()) { settle(); return; }
  if (dlSettleTimer) return; // a settle loop is already running for this row
  let left = 10; // ~30s at 3s cadence — ample for chain-read lag
  dlSettleTimer = setInterval(async () => {
    if (left-- <= 0) { settle(); return; }
    await loadDualLinks();
    if (shows()) settle();
  }, 3000);
}

// Deactivate ("API Break") — ancient-only. Confirm → POST /admin/connectors/break
// (x-pythia-confirmed) → the dual-link-break cronoton fires A_RevokeLink on-chain.
async function apiBreak(dualLinkKey) {
  const ok = await confirmDialog({
    title: "Deactivate this link? (API Break)",
    message:
      "This revokes the ACTIVE dual link on-chain via A_RevokeLink — the consumer's gated access stops. Ancient-only, and irreversible without re-linking + re-activating.",
    confirmLabel: "Deactivate",
    danger: true,
  });
  if (!ok) return;
  dlState.busy = true;
  renderDualLinks();
  try {
    const res = await fetch("/admin/connectors/break", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-pythia-confirmed": "1" },
      body: JSON.stringify({ dualLinkKey }),
    });
    const body = await res.json().catch(() => ({}));
    dlState.busy = false;
    if (res.ok && body.ok) {
      dlState.selKey = null;
      loadDualLinks(); // refresh — the row flips inactive once the revoke mines
      return;
    }
    let msg;
    if (res.status === 401 || res.status === 403) msg = "ancient admin session required — log in via the Admin dashboard.";
    else if (body.code === "break_resolver_unregistered") msg = "no dual-link-break cronoton is set up yet — create one in the Khronoton admin.";
    else msg = body.error || `break failed (HTTP ${res.status})`;
    dlState.actPhase = null;
    renderDualLinks();
    setDlActionError(msg);
  } catch (e) {
    dlState.busy = false;
    renderDualLinks();
    setDlActionError(e.message || "break request failed");
  }
}
function setDlActionError(msg) {
  const el = document.getElementById("dl-action-error");
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

// The inline context action zone for the SELECTED row.
function buildDlActions(r, key, active) {
  const zone = el("div", "dl-actions");
  if (!active) {
    // INACTIVE → Verify & Activate (API Link), any viewer.
    const std = r["standard-apollo"];
    const smart = r["smart-apollo"];
    const phase = dlState.actPhase;
    if (phase === "activated") {
      zone.appendChild(el("span", "dl-act-phase dl-act-phase--ok", "Activated — refreshing…"));
    } else if (phase === "activating") {
      zone.appendChild(el("span", "dl-act-phase dl-act-phase--live", "Proven — Pythia is firing A_Link…"));
    } else {
      const btn = el("button", "btn btn--primary dl-act-btn", "Verify & Activate (API Link)");
      btn.type = "button";
      btn.title = "Prove ownership of both halves, then Pythia autonomously activates the link";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openVerifyPopup({ std, smart, onDone: () => loadDlActivation(std, smart) });
      });
      zone.appendChild(btn);
      if (phase === "pending") {
        zone.appendChild(el("span", "dl-act-phase", "One or both halves not yet proven — verify to activate."));
      }
    }
  } else if (isAncient()) {
    // ACTIVE + ancient → Deactivate (API Break).
    const btn = el("button", "btn btn--danger dl-act-btn", dlState.busy ? "Deactivating…" : "Deactivate (API Break)");
    btn.type = "button";
    btn.disabled = dlState.busy;
    btn.addEventListener("click", (e) => { e.stopPropagation(); apiBreak(key); });
    zone.appendChild(btn);
  } else {
    // ACTIVE, non-ancient → nothing actionable.
    zone.appendChild(el("span", "dl-act-phase", "Active. Only the ancient admin can deactivate (API Break)."));
  }
  const err = el("p", "conn-error dl-act-err");
  err.id = "dl-action-error";
  err.hidden = true;
  zone.appendChild(err);
  return zone;
}

function dualLinkRow(r) {
  const active = r["iz-active"] === true;
  const row = document.createElement("div");
  const key = dualLinkKeyOf(r);
  const selected = key && dlState.selKey === key;
  row.className = "dl-row" + (active ? "" : " dl-row--off") + (selected ? " dl-row--sel" : "");

  const copyBtn = key ? copyKeyButton(key) : null;

  const main = document.createElement("div");
  main.className = "dl-main";
  const std = document.createElement("code");
  std.className = "apollo apollo--std";
  std.textContent = shortApollo(r["standard-apollo"]);
  std.title = r["standard-apollo"] || "";
  const arrow = document.createElement("span");
  arrow.className = "dl-arrow";
  arrow.textContent = "↔";
  const smart = document.createElement("code");
  smart.className = "apollo apollo--smart";
  smart.textContent = shortApollo(r["smart-apollo"]);
  smart.title = r["smart-apollo"] || "";
  main.append(std, arrow, smart);

  const meta = document.createElement("div");
  meta.className = "dl-meta";
  const badge = document.createElement("span");
  badge.className = "dl-badge " + (active ? "dl-badge--on" : "dl-badge--off");
  badge.textContent = active ? "active" : "inactive";
  meta.appendChild(badge);
  if (r["consumer-lane"] && r["consumer-lane"] !== BAR) {
    const lane = document.createElement("span");
    lane.className = "dl-lane";
    lane.textContent = r["consumer-lane"];
    meta.appendChild(lane);
  }
  const when = fmtTime(r["linked-at"]);
  if (when) {
    const t = document.createElement("span");
    t.className = "dl-when";
    t.textContent = `linked ${when}`;
    meta.appendChild(t);
  }

  if (copyBtn) row.prepend(copyBtn);
  row.append(main, meta);

  // Selectable: clicking the row (not the copy/action buttons — those stopPropagation)
  // toggles selection and reveals the context action. Only linked rows (with a key).
  if (key) {
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-pressed", selected ? "true" : "false");
    row.addEventListener("click", () => selectDlRow(key));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectDlRow(key); }
    });
    if (selected) row.appendChild(buildDlActions(r, key, active));
  }
  return row;
}

// ── sub-tab 2: register — link two unlinked halves ──────────────────────────
let regState = {
  halves: [],
  loaded: false,
  std: { search: "", page: 0 },
  smart: { search: "", page: 0 },
  selStd: null,
  selSmart: null,
  proven: [], // apollo accounts proven this session (server truth)
  activation: null, // autonomous activation phase for the selected pair: "pending"|"activating"|"activated"|null
};
let halvesReqSeq = 0;

async function loadHalves() {
  const status = document.getElementById("reg-status");
  const seq = ++halvesReqSeq;
  if (status) status.textContent = "reading chain…";
  // Show a loading state in BOTH columns immediately (the read can take seconds).
  renderReading(document.querySelector('[data-role="std-list"]'));
  renderReading(document.querySelector('[data-role="smart-list"]'));
  try {
    const data = await pythiaRead(`(${PYTHIA_NS}.PYTHIA.URD_ListAllApiKeys)`);
    if (seq !== halvesReqSeq) return; // superseded by a newer reload
    regState.halves = Array.isArray(data) ? data : [];
    regState.loaded = true;
    // A prior selection may be stale after a reload — re-point it to the fresh row.
    regState.selStd = reselect(regState.selStd);
    regState.selSmart = reselect(regState.selSmart);
    if (status) {
      const n = regState.halves.length;
      status.textContent = `${n} half-key${n === 1 ? "" : "s"} on chain`;
    }
    renderHalves("std");
    renderHalves("smart");
    updateActionBar();
  } catch (e) {
    if (seq !== halvesReqSeq) return;
    if (status) status.textContent = `read failed — ${e.message}`;
  }
}

function reselect(sel) {
  if (!sel) return null;
  return regState.halves.find((h) => h["apollo-account"] === sel["apollo-account"]) || null;
}

function halvesFor(side) {
  const pred = side === "std" ? isStandardApollo : isSmartApollo;
  const q = regState[side].search.trim().toLowerCase();
  return regState.halves.filter((h) => {
    const acct = h["apollo-account"];
    if (!pred(acct)) return false;
    if (q && !String(acct).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderHalves(side) {
  const list = document.querySelector(`[data-role="${side}-list"]`);
  const pager = document.querySelector(`[data-role="${side}-pager"]`);
  if (!list) return;
  const rows = halvesFor(side);
  const pageCount = Math.max(1, Math.ceil(rows.length / HALF_PAGE));
  if (regState[side].page >= pageCount) regState[side].page = pageCount - 1;
  const slice = rows.slice(regState[side].page * HALF_PAGE, regState[side].page * HALF_PAGE + HALF_PAGE);
  list.textContent = "";
  if (!slice.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = regState.halves.length ? "No halves match." : "No halves registered yet.";
    list.appendChild(p);
  } else {
    const selected = side === "std" ? regState.selStd : regState.selSmart;
    for (const h of slice) list.appendChild(halfRow(h, side, selected));
  }
  if (pager) renderPager(pager, regState[side].page, pageCount, (p) => { regState[side].page = p; renderHalves(side); });
}

function halfRow(h, side, selected) {
  const acct = h["apollo-account"];
  const unlinked = isUnlinked(h.counterpart);
  const isSel = selected && selected["apollo-account"] === acct;
  const row = document.createElement("button");
  row.type = "button";
  row.className =
    "half-row" + (isSel ? " half-row--sel" : "") + (unlinked ? "" : " half-row--linked");

  const label = document.createElement("code");
  label.className = "half-acct";
  label.textContent = shortApollo(acct);
  label.title = acct || "";

  const badge = document.createElement("span");
  badge.className = "half-badge " + (unlinked ? "half-badge--free" : "half-badge--linked");
  badge.textContent = unlinked ? "unlinked" : "linked";

  row.append(label, badge);
  row.addEventListener("click", () => selectHalf(side, h));
  return row;
}

// Clicking a half toggles it: pick it, or unpick it if it's the current pick.
function selectHalf(side, h) {
  const cur = side === "std" ? regState.selStd : regState.selSmart;
  const same = cur && cur["apollo-account"] === h["apollo-account"];
  const next = same ? null : h;
  if (side === "std") regState.selStd = next;
  else regState.selSmart = next;
  renderHalves(side);
  updateActionBar();
}

// `regState.proven` is the SERVER's truth — the set of apollo accounts this
// browser session has proven ownership of (from /api/connectors/verify/status).
// A half is "verified" iff its account is in that set; the pair is verified when
// BOTH selected halves are. Nothing client-side is trusted for unlocking Link.
function isHalfProven(h) {
  return !!h && regState.proven.includes(h["apollo-account"]);
}

// Sync the register panel's status line (#reg-status) to the autonomous activation
// phase. Called from updateActionBar on every poll, so the line tracks the same
// phase as the top selection line and never freezes on a stale "checking…" once
// activation lands on-chain.
function setRegActivationStatus(phase) {
  const status = document.getElementById("reg-status");
  if (!status) return;
  status.textContent =
    phase === "activated"
      ? "API link active — Pythia's automaton fired A_LinkDualApiKey."
      : phase === "activating"
        ? "Activating the API link — Pythia's dual-link-activate cronoton is firing A_LinkDualApiKey…"
        : "Both halves verified — Pythia will activate the API link autonomously.";
}

// Two-stage flow: (1) VERIFY ownership of both selected unlinked halves — enabled
// when two unlinked halves are picked; (2) LINK — stays locked until BOTH halves
// are proven, then lights up (its on-chain action is deferred: it will signal the
// AncientHub DALOS Automaton to submit the link tx).
function updateActionBar() {
  const verifyBtn = document.getElementById("verify-btn");
  const linkBtn = document.getElementById("link-btn");
  const sel = document.getElementById("link-selection");
  if (!verifyBtn || !linkBtn || !sel) return;
  const s = regState.selStd;
  const m = regState.selSmart;
  const sProven = isHalfProven(s);
  const mProven = isHalfProven(m);

  sel.textContent = "";
  if (!s && !m) {
    sel.textContent = "Select one unlinked half from each side.";
  } else {
    const pair = document.createElement("span");
    pair.className = "link-pair";
    const std = document.createElement("code");
    std.className = "apollo--std";
    std.textContent = (s ? shortApollo(s["apollo-account"]) : "₱. —") + (sProven ? " ✓" : "");
    const smart = document.createElement("code");
    smart.className = "apollo--smart";
    smart.textContent = (m ? shortApollo(m["apollo-account"]) : "Π. —") + (mProven ? " ✓" : "");
    pair.append(std, document.createTextNode(" ↔ "), smart);
    sel.appendChild(pair);
    const warn = [];
    if (s && !isUnlinked(s.counterpart)) warn.push("Standard half already linked");
    if (m && !isUnlinked(m.counterpart)) warn.push("Smart half already linked");
    if (warn.length) {
      const w = document.createElement("span");
      w.className = "link-warn";
      w.textContent = " — " + warn.join("; ");
      sel.appendChild(w);
    } else if (s && m) {
      const note = document.createElement("span");
      if (sProven && mProven) {
        // Both proven → activation is AUTONOMOUS. Reflect the live phase reported
        // by /status: Pythia's dual-link-activate cronoton fires A_LinkDualApiKey.
        if (regState.activation === "activated") {
          note.className = "link-ok";
          note.textContent = " — API link active ✓ — Pythia fired A_LinkDualApiKey";
        } else if (regState.activation === "activating") {
          note.className = "link-warn";
          note.textContent = " — both halves verified ✓ — activating the API link (autonomous)…";
        } else {
          note.className = "link-ok";
          note.textContent = " — both halves verified ✓ — Pythia will activate the API link";
        }
        // Keep the panel status line (#reg-status) in sync with the SAME live phase,
        // updated on every poll — so it never freezes on a stale "Checking status…"
        // after activation lands (the top line and this line must agree).
        setRegActivationStatus(regState.activation);
      } else if (sProven || mProven) {
        note.className = "link-warn";
        note.textContent = " — one half verified; verify the other (load the Codex that holds it)";
      }
      sel.appendChild(note);
    }
  }

  const bothUnlinked = !!(s && m && isUnlinked(s.counterpart) && isUnlinked(m.counterpart));
  verifyBtn.disabled = !bothUnlinked;
  // The "Link" affordance is now a live activation STATE, not a manual trigger —
  // activation fires autonomously once both halves prove. It stays disabled until
  // then, and once activated it shows the confirmed on-chain result.
  const activated = regState.activation === "activated";
  linkBtn.disabled = !(bothUnlinked && sProven && mProven);
  linkBtn.textContent = activated ? "API Link Active ✓" : "API Link";
  linkBtn.title = activated
    ? "Pythia's automaton fired A_LinkDualApiKey — the dual API link is active on-chain"
    : sProven && mProven
      ? "Activation is autonomous — Pythia's dual-link-activate cronoton fires A_LinkDualApiKey. Click to re-check status."
      : "Unlocks once both halves are verified — activation is then autonomous";
}

// Pull the proven set (and, for the currently-selected pair, the autonomous
// activation phase) from the server and refresh the action bar. Passing the pair
// lets the server report whether Pythia's `dual-link-activate` cronoton has fired
// `A_LinkDualApiKey` for it yet — "pending" → "activating" → "activated".
async function loadProven() {
  const s = regState.selStd && regState.selStd["apollo-account"];
  const m = regState.selSmart && regState.selSmart["apollo-account"];
  let url = "/api/connectors/verify/status";
  if (s && m) {
    url += `?standard=${encodeURIComponent(s)}&smart=${encodeURIComponent(m)}`;
  }
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = await res.json();
    regState.proven = Array.isArray(body.proven) ? body.proven : [];
    regState.activation = typeof body.activation === "string" ? body.activation : null;
  } catch {
    /* keep the last-known set */
  }
  updateActionBar();
  maybePollActivation();
}

// Once both halves are proven, activation is AUTONOMOUS (Pythia's cronoton fires
// A_LinkDualApiKey on its next tick) — so poll a few times to catch the
// "activating" → "activated" transition live, then stop. Idempotent: only one
// timer runs, and it clears itself once activated (or after a bounded number of
// tries, so a never-confirming pair doesn't poll forever).
let activationPollTimer = null;
let activationPollLeft = 0;
function maybePollActivation() {
  const a = regState.activation;
  if (a === "activating") {
    if (!activationPollTimer) {
      activationPollLeft = 20; // ~100s at 5s cadence — generous for one tick + confirm
      activationPollTimer = setInterval(() => {
        if (activationPollLeft-- <= 0) { stopActivationPoll(); return; }
        loadProven();
      }, 5000);
    }
  } else {
    stopActivationPoll(); // "activated"/"pending"/null → nothing in flight to watch
  }
}
function stopActivationPoll() {
  if (activationPollTimer) { clearInterval(activationPollTimer); activationPollTimer = null; }
  activationPollLeft = 0;
}

// Stage 1 — VERIFY ownership. Pythia is keyless, so it can't sign; this popup
// deep-links out to a wallet/Codex that holds the user's DALOS seed to prove
// ownership of BOTH halves. Once Pythia confirms the proof, the Link step (stage
// 2) unlocks. This popup does NOT submit the link itself.
function openVerifyPopup(opts) {
  // Two callers: the register view (two picked UNLINKED halves, from regState) and
  // the dual-link list's "API Link" activate (an already-linked-but-INACTIVE pair,
  // passed as { std, smart } account strings). The verify flow itself is
  // link-state-agnostic — it only proves ownership of two accounts.
  let std, smart, onDone, flow;
  if (opts && typeof opts.std === "string" && typeof opts.smart === "string") {
    std = opts.std;
    smart = opts.smart;
    onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    flow = "dual-link"; // API-keys list "API Link": activate a pre-linked INACTIVE pair
  } else {
    const s = regState.selStd;
    const m = regState.selSmart;
    if (!s || !m || !isUnlinked(s.counterpart) || !isUnlinked(m.counterpart)) return;
    std = s["apollo-account"];
    smart = m["apollo-account"];
    flow = "register"; // two freshly-picked UNLINKED halves
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const prevFocus = document.activeElement;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Single close path so EVERY dismissal (Escape, backdrop, Cancel, refresh)
  // unbinds the document listener — no per-open handler leak.
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
  };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h3", "modal-h", "Verify ownership → unlock Link"));
  modal.appendChild(
    el(
      "p",
      "modal-note",
      "Pythia is keyless — it never signs. Prove you own both Apollo halves in a wallet or Codex that holds your DALOS seed. Once Pythia confirms the proof, the Link step unlocks (linking itself, and the 250 STOA at activation, happens on-chain — not here).",
    ),
  );

  const pair = el("div", "modal-pair");
  pair.append(
    el("span", "mp-lbl", "Standard ₱."),
    el("code", "apollo--std", std),
    el("span", "mp-lbl", "Smart Π."),
    el("code", "apollo--smart", smart),
  );
  modal.appendChild(pair);

  modal.appendChild(el("label", "modal-lbl", "Verify at"));
  const select = document.createElement("select");
  select.className = "modal-select";
  select.disabled = true;
  select.appendChild(el("option", null, "loading verifiers…"));
  modal.appendChild(select);

  // The admin-curated verifier registry (public GET /api/verifiers). Each entry's
  // baseUrl already includes the port; the picker offers whatever the ancient
  // admin added — empty until they add one in the Admin dashboard.
  let verifiers = [];
  const RP = "pythia.ancientholdings.eu";
  const callbackUrl = location.origin + "/connectors/verify/callback";
  const selectedVerifier = () => verifiers.find((v) => v.id === select.value) || null;
  const buildUrl = (nonce) => {
    const v = selectedVerifier();
    if (!v) return "";
    const accounts = `${encodeURIComponent(std)},${encodeURIComponent(smart)}`;
    return (
      `${v.baseUrl}/apollo-verify?accounts=${accounts}` +
      `&challenge=${encodeURIComponent(nonce)}` +
      `&rp=${encodeURIComponent(RP)}` +
      `&callback=${encodeURIComponent(callbackUrl)}`
    );
  };

  const emptyNote = el("p", "modal-note", "No verifiers configured yet — an ancient admin adds them in the Admin dashboard (/admin).");
  emptyNote.hidden = true;
  modal.appendChild(emptyNote);

  modal.appendChild(el("span", "modal-lbl", "Hand-off link (nonce added on open)"));
  const preview = el("code", "modal-link", "");
  const refreshPreview = () => {
    const v = selectedVerifier();
    if (v) {
      localStorage.setItem("pythia_verify_v", v.id);
      preview.textContent = buildUrl("<challenge>");
    } else {
      preview.textContent = "";
    }
  };
  select.addEventListener("change", refreshPreview);
  modal.appendChild(preview);

  const err = el("p", "conn-error", "");
  err.hidden = true;
  modal.appendChild(err);

  const actions = el("div", "modal-actions");
  const go = document.createElement("button");
  go.className = "btn btn--primary";
  go.type = "button";
  go.textContent = "Open verifier ↗";
  go.addEventListener("click", async () => {
    err.hidden = true;
    if (!selectedVerifier()) {
      err.textContent = "pick a verifier first";
      err.hidden = false;
      return;
    }
    go.disabled = true;
    try {
      // Mint a nonce bound to this pair + browser session, remember what we're
      // verifying (survives the round-trip), then hand off to the verifier.
      const res = await fetch("/api/connectors/verify/start", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ standard: std, smart }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.nonce) throw new Error(body.error || "could not start verification");
      // Persist the flow too: the same-tab verifier round-trip destroys the
      // in-memory `onDone` closure, so `resumePendingVerify` recovers which flow
      // (register vs dual-link activation) to return to from this marker alone.
      sessionStorage.setItem(
        "pythia_verify_pending",
        JSON.stringify({ standard: std, smart, flow }),
      );
      window.location.href = buildUrl(body.nonce); // same-tab; returns to /#connectors
    } catch (e) {
      go.disabled = false;
      err.textContent = e.message || "could not start verification";
      err.hidden = false;
    }
  });
  const done = document.createElement("button");
  done.className = "btn btn--ghost";
  done.type = "button";
  done.textContent = "Done — recheck";
  done.addEventListener("click", () => {
    close();
    if (onDone) onDone();
    else { loadProven(); loadHalves(); loadDualLinks(); }
  });
  const cancel = document.createElement("button");
  cancel.className = "btn btn--ghost";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  actions.append(go, done, cancel);
  modal.appendChild(actions);

  // Populate the picker from the admin-curated verifier registry.
  fetch("/api/verifiers", { headers: { accept: "application/json" } })
    .then((r) => r.json())
    .then((b) => {
      verifiers = Array.isArray(b.verifiers) ? b.verifiers : [];
      select.textContent = "";
      if (!verifiers.length) {
        select.disabled = true;
        select.appendChild(el("option", null, "— none —"));
        emptyNote.hidden = false;
        go.disabled = true;
        return;
      }
      select.disabled = false;
      for (const v of verifiers) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.label;
        select.appendChild(o);
      }
      const last = localStorage.getItem("pythia_verify_v");
      if (last && verifiers.some((v) => v.id === last)) select.value = last;
      refreshPreview();
    })
    .catch(() => {
      select.textContent = "";
      select.disabled = true;
      select.appendChild(el("option", null, "failed to load verifiers"));
      go.disabled = true;
    });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  go.focus(); // move focus into the dialog for keyboard users
}

// After returning from a verifier, restore the pair we were proving, reload the
// halves + proven set, and let updateActionBar light up Link if both verified.
// The pending flag survives a partial (one-of-two) proof so the user can resume
// at another Codex; it clears once both halves are proven.
async function resumePendingVerify() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem("pythia_verify_pending") || "null");
  } catch {
    pending = null;
  }
  if (!pending || !pending.standard || !pending.smart) return;

  // Dual-link "API Link" activation flow (from the API-keys list): the verifier
  // callback already recorded the proof + fired A_LinkDualApiKey server-side —
  // return to the API-keys list, reselect the pair's row, and poll the live
  // activation phase so the operator sees "firing A_Link… → Activated" in place.
  // (The register-flow reselection below only knows unlinked halves, so a
  // pre-linked pair would land on a screen that can't reflect its activation.)
  if (pending.flow === "dual-link") {
    goTo("#connectors/apikeys");
    await loadDualLinks(); // authoritative rows (default "all" filter includes the inactive row)
    // The composite key is deterministic (std|smart) — matching dualLinkKeyOf(row) for
    // the pair's row — so select by it directly rather than depending on a row lookup.
    dlState.selKey = `${pending.standard}${BAR}${pending.smart}`;
    renderDualLinks();
    await loadDlActivation(pending.standard, pending.smart);
    // Clear once the pair is recorded (activating) or done (activated); a still-
    // "pending" pair keeps the marker so a resume at another verifier can finish
    // the second half.
    if (dlState.actPhase === "activating" || dlState.actPhase === "activated") {
      sessionStorage.removeItem("pythia_verify_pending");
    }
    return;
  }

  goTo("#connectors/register"); // addressable: switch to connectors + the register sub-view
  await loadHalves(); // authoritative reload to re-point selection against
  regState.selStd = regState.halves.find((h) => h["apollo-account"] === pending.standard) || null;
  regState.selSmart = regState.halves.find((h) => h["apollo-account"] === pending.smart) || null;
  renderHalves("std");
  renderHalves("smart");
  await loadProven();
  // Clear the resume marker only once BOTH halves are re-selected AND proven — so a
  // failed halves reload (empty list → null selection) doesn't discard a still-
  // usable pending state and leave Link un-lit.
  if (
    regState.selStd &&
    regState.selSmart &&
    regState.proven.includes(pending.standard) &&
    regState.proven.includes(pending.smart)
  ) {
    sessionStorage.removeItem("pythia_verify_pending");
  }
}

// Wire the Connectors tab once at boot (elements are static in the panel).
// The sub-view switch (Full API Keys / Register) is owned by the header tier-2
// (showConnectorSubview), not an in-panel nav — nothing to wire here for it.
function wireConnectors() {
  const panel = document.querySelector('[data-panel="connectors"]');
  if (!panel) return;

  const filter = document.getElementById("dl-filter");
  if (filter) {
    filter.querySelectorAll("[data-filter]").forEach((b) => {
      b.addEventListener("click", () => {
        dlState.filter = b.dataset.filter;
        filter.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("seg-btn--active", x === b));
        loadDualLinks();
      });
    });
  }
  const dlSearch = document.getElementById("dl-search");
  if (dlSearch) dlSearch.addEventListener("input", () => { dlState.search = dlSearch.value; dlState.page = 0; renderDualLinks(); });
  const dlRefresh = document.getElementById("dl-refresh");
  if (dlRefresh) dlRefresh.addEventListener("click", loadDualLinks);

  const stdSearch = panel.querySelector('[data-role="std-search"]');
  if (stdSearch) stdSearch.addEventListener("input", () => { regState.std.search = stdSearch.value; regState.std.page = 0; renderHalves("std"); });
  const smartSearch = panel.querySelector('[data-role="smart-search"]');
  if (smartSearch) smartSearch.addEventListener("input", () => { regState.smart.search = smartSearch.value; regState.smart.page = 0; renderHalves("smart"); });
  const verifyBtn = document.getElementById("verify-btn");
  if (verifyBtn) verifyBtn.addEventListener("click", openVerifyPopup);
  const linkBtn = document.getElementById("link-btn");
  if (linkBtn) {
    // Activation is AUTONOMOUS: once both halves prove ownership, Pythia's own
    // dual-link-activate cronoton fires A_LinkDualApiKey on its next tick — no
    // manual submit. The button (enabled only once both halves are proven) just
    // re-checks the live activation phase reported by /status.
    linkBtn.addEventListener("click", () => {
      // Activation is autonomous; the button just forces a re-check. The status
      // line is kept in sync with the live phase by updateActionBar (→
      // setRegActivationStatus) on the poll — so it can't freeze on "checking…".
      loadProven();
    });
  }
  const regRefresh = document.getElementById("reg-refresh");
  if (regRefresh) regRefresh.addEventListener("click", loadHalves);
}

// ── refresh loop ─────────────────────────────────────────────────────────────
function createRefreshLoop({ fetchSnapshot, onSnapshot, onError, intervalMs }) {
  const tick = () => {
    fetchSnapshot().then(onSnapshot).catch(onError || (() => {}));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

async function fetchHealth() {
  const res = await fetch("/healthz", { headers: { accept: "application/json" } });
  return res.json();
}

// ── per-chain dirty-read console ────────────────────────────────────────────
function wireConsole(root, base) {
  const btn = root.querySelector('[data-role="run"]');
  const code = root.querySelector('[data-role="code"]');
  const chain = root.querySelector('[data-role="chainid"]');
  const out = root.querySelector('[data-role="out"]');
  const status = root.querySelector('[data-role="status"]');
  if (!btn || !code || !out) return;

  async function run() {
    const src = code.value.trim();
    if (!src) {
      status.textContent = "enter some Pact read code";
      return;
    }
    const chainId = Number(chain ? chain.value : 0) || 0;
    status.textContent = "reading…";
    out.textContent = "";
    btn.disabled = true;
    try {
      const res = await fetch(`${base}/read`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ chainId, code: src }),
      });
      const raw = await res.text();
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* not JSON — show raw */
      }
      out.textContent = pretty || "(empty response)";
      status.textContent = `HTTP ${res.status}`;
    } catch (err) {
      status.textContent = "request failed";
      out.textContent = String(err);
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", run);
  code.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
}

// ── chain module (node pool + console + endpoints) ──────────────────────────
function chainIdOptions(chain) {
  let out = "";
  for (let n = 0; n <= 9; n++) {
    out += `<option value="${n}"${n === 0 ? " selected" : ""}>${chain.name} · ${n}</option>`;
  }
  return out;
}

// Observation Pool summary (public): a health dot + node count, no URLs.
function renderObservation(el, obs) {
  el.textContent = "";
  const dot = document.createElement("span");
  dot.className = "dot";
  let color = "grey";
  let text = "hub feed off";
  if (obs) {
    if (obs.configured && obs.ok && obs.count > 0) {
      color = "green";
      text = `${obs.count} hub node${obs.count === 1 ? "" : "s"} live`;
    } else if (obs.configured && obs.ok) {
      color = "amber";
      text = "feed reachable · 0 nodes";
    } else if (obs.configured) {
      color = "red";
      text = "feed error";
    }
  }
  dot.setAttribute("data-color", color);
  const span = document.createElement("span");
  span.className = "source-label";
  span.textContent = text;
  el.append(dot, span);
}

// Upload Pool count (public): the seed nodes are listed above; this notes how
// many more (admin-added) senders exist, without exposing their URLs.
function renderUploadCount(el, upload) {
  if (!upload) {
    el.textContent = "";
    return;
  }
  const seeds = Array.isArray(upload.seeds) ? upload.seeds : [];
  const extra = upload.count - seeds.length;
  el.textContent =
    extra > 0
      ? `+ ${extra} more sender${extra === 1 ? "" : "s"} · ${upload.count} enabled total`
      : `${upload.count} enabled`;
}

function renderChainModule(chain) {
  if (stopChainHealth) {
    stopChainHealth();
    stopChainHealth = null;
  }
  const mod = document.getElementById("chain-module");
  if (!mod) return;

  if (chain.status !== "live") {
    mod.innerHTML = `
      <div class="chain-soon">
        <span class="chain-badge chain-badge--soon">Coming soon</span>
        <h3>${chain.name} <span class="chain-kind">· ${chain.kind}</span></h3>
        <p>${chain.blurb}</p>
      </div>`;
    return;
  }

  mod.innerHTML = `
    <div class="chain-head">
      <h3>${chain.name} <span class="chain-kind">· ${chain.kind}</span></h3>
      <span class="chain-badge chain-badge--live">Live</span>
    </div>

    <nav class="subtabs" data-role="chain-subtabs" role="tablist" aria-label="${chain.name} views">
      <button class="subtab subtab--active" data-subtab="pools" role="tab" type="button">Pools</button>
      <button class="subtab" data-subtab="endpoints" role="tab" type="button">Endpoints</button>
      <button class="subtab" data-subtab="read" role="tab" type="button">Dirty Read</button>
    </nav>

    <div class="subpanel" data-subpanel="pools">
      <div class="sub">
        <div class="sub-head"><h4>Node pools</h4><span class="sub-note"><code>/api/pools</code></span></div>
        <div class="pool-block">
          <div class="pool-title">Observation Pool <span class="pool-sub">· hub-fed reads</span></div>
          <div class="pool-summary" data-role="observation"><span class="dot" data-color="grey"></span><span class="source-label">checking…</span></div>
        </div>
        <div class="pool-block">
          <div class="pool-title">Upload Pool <span class="pool-sub">· signed-tx senders</span></div>
          <div class="sources" data-role="upload-seeds" aria-live="polite">
            <div class="source-row"><span class="dot" data-color="grey"></span><span class="source-label">checking…</span></div>
          </div>
          <p class="pool-count" data-role="upload-count"></p>
        </div>
      </div>
    </div>

    <div class="subpanel" data-subpanel="endpoints" hidden>
      <div class="sub">
        <div class="sub-head"><h4>Endpoints</h4><span class="sub-note">one keyless surface · same shape every chain</span></div>
        <ul class="endpoints endpoints--compact">
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/read</code><span class="ep-note">dirty read — caller supplies Pact code</span></li>
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/send</code><span class="ep-note">keyless broadcast — relay caller-signed txs</span></li>
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/poll</code><span class="ep-note">tx status — pending vs final + depth</span></li>
        </ul>
      </div>
    </div>

    <div class="subpanel" data-subpanel="read" hidden>
      <div class="sub">
        <div class="sub-head"><h4>Try a dirty read</h4><span class="sub-note">read-only Pact code · no keys involved</span></div>
        <div class="console">
          <div class="console-controls">
            <label class="console-chain">Chain
              <select data-role="chainid" aria-label="Chain id">${chainIdOptions(chain)}</select>
            </label>
            <button data-role="run" class="btn btn--primary" type="button">Read</button>
            <span data-role="status" class="console-status" aria-live="polite"></span>
          </div>
          <textarea data-role="code" class="console-code" spellcheck="false" rows="4"></textarea>
          <pre data-role="out" class="console-out" aria-live="polite">// the node's dirty-read result appears here</pre>
        </div>
      </div>
    </div>`;

  // Wire the three sub-tabs (Pools | Endpoints | Dirty Read), SCOPED to this
  // module so it never toggles the Hub-feed sub-panels (also [data-subpanel]).
  wireSubtabs(mod.querySelector('[data-role="chain-subtabs"]'), mod);

  // set the placeholder via property so the example's quotes/newlines are literal
  const code = mod.querySelector('[data-role="code"]');
  if (code) code.placeholder = chain.readExample || "";

  // this chain's node-pool health poll: /healthz for seed reachability +
  // /api/pools for the two-pool sizes.
  const uploadSeeds = mod.querySelector('[data-role="upload-seeds"]');
  const observation = mod.querySelector('[data-role="observation"]');
  const uploadCount = mod.querySelector('[data-role="upload-count"]');
  stopChainHealth = createRefreshLoop({
    fetchSnapshot: () =>
      Promise.all([
        fetch(chain.health, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null),
        fetch("/api/pools", { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null),
      ]),
    onSnapshot: ([snap, pools]) => {
      if (uploadSeeds && snap) renderSources(uploadSeeds, snap.sources, snap.routing);
      if (observation && pools) renderObservation(observation, pools.observation);
      if (uploadCount && pools) renderUploadCount(uploadCount, pools.upload);
    },
    onError: () => {},
    intervalMs: POLL_INTERVAL_MS,
  });

  wireConsole(mod, chain.base);
}

// ── chain selector ──────────────────────────────────────────────────────────
// The chain selector lives ONLY in the header's tier-2 row (renderTier2) — there
// is no in-panel button list. `currentChainId` is the sole active-state truth.
let currentChainId = CHAINS[0].id;
function selectChain(id) {
  currentChainId = id;
  const chain = CHAINS.find((c) => c.id === id);
  if (chain) renderChainModule(chain);
}

// ── auth / session (site-wide) ───────────────────────────────────────────────
let authState = { authenticated: false, roles: [], name: null };

function isAncient() {
  return authState.authenticated && authState.roles.includes("ancient");
}

function renderAuthbox() {
  // Delegate to the ONE shared Pantheonic Header renderer. The landing variant
  // includes the Admin link (real /admin for ancients; a disabled chip otherwise).
  renderIdentity(document.getElementById("authbox"), authState, { adminLink: true });
}

async function loadMe() {
  try {
    const res = await fetch("/api/me", { headers: { accept: "application/json" } });
    const body = await res.json();
    authState = {
      authenticated: !!body.authenticated,
      roles: Array.isArray(body.roles) ? body.roles : [],
      name: body.name || null,
    };
  } catch {
    authState = { authenticated: false, roles: [], name: null };
  }
  renderAuthbox();
}

// Generic sub-tab switcher: clicking a [data-subtab] button in `nav` shows the
// matching [data-subpanel] within `scope` and hides its siblings. `scope` is
// REQUIRED (not the document) so multiple sub-tab groups on the page — the Hub
// feed and each chain module both use [data-subpanel] — never toggle each other.
function wireSubtabs(nav, scope) {
  if (!nav || !scope) return;
  const buttons = Array.from(nav.querySelectorAll("[data-subtab]"));
  const panels = Array.from(scope.querySelectorAll("[data-subpanel]"));
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.subtab;
      buttons.forEach((b) => b.classList.toggle("subtab--active", b === btn));
      panels.forEach((p) => {
        p.hidden = p.dataset.subpanel !== name;
      });
    });
  });
}

function startHealthPill() {
  createRefreshLoop({
    fetchSnapshot: () =>
      Promise.all([
        fetch("/api/pools", { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null),
        fetch("/healthz", { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null),
      ]),
    onSnapshot: ([pools, health]) => renderMedallions(pools, health),
    onError: () => renderMedallions(null, null),
    intervalMs: POLL_INTERVAL_MS,
  });
}

// ── activity / usage analytics ───────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_DAYS = 30; // the bar chart shows the last 30 daily buckets

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Expand the (gap-filled) daily series to exactly `n` days ending on the latest
// day present, so the chart always has a consistent axis. Each record carries the
// day's STONE (on-chain) + AIR (local backlog) petition counts.
function padDays(daily, n) {
  if (!daily.length) return [];
  const map = new Map(daily.map((d) => [d.day, d]));
  const end = new Date(daily[daily.length - 1].day + "T00:00:00Z");
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(end);
    dt.setUTCDate(end.getUTCDate() - i);
    const key = dt.toISOString().slice(0, 10);
    const rec = map.get(key);
    out.push({ day: key, stone: rec ? rec.stone || 0 : 0, air: rec ? rec.air || 0 : 0 });
  }
  return out;
}

/** One SVG bar rect with a hover title. */
function chartBar(x, y, w, h, cls, title) {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", cls);
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(w));
  rect.setAttribute("height", String(Math.max(0, h)));
  rect.setAttribute("rx", "1.5");
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = title;
  rect.appendChild(t);
  return rect;
}

// A vanilla SVG STACKED bar chart of daily petitions — STONE (on-chain, at the
// base) + AIR (local backlog, stacked on top). Two colours; no chart library.
// `daily` = [{ day: "YYYY-MM-DD", stone, air }].
function buildActivityChart(daily) {
  const days = padDays(daily, CHART_DAYS);
  const W = 640;
  const H = 112; // compact — the Activity panel fits a fixed height on the landing
  const pad = { top: 6, right: 8, bottom: 14, left: 8 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = days.reduce((m, d) => Math.max(m, (d.stone || 0) + (d.air || 0)), 0) || 1;
  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(slot * 0.68, 20));

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "activity-chart");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Daily petitions (stone on-chain + air pending) over the last ${days.length} days`);

  days.forEach((d, i) => {
    const stoneH = ((d.stone || 0) / max) * plotH;
    const airH = ((d.air || 0) / max) * plotH;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const baseY = pad.top + plotH;
    if (stoneH > 0) {
      svg.appendChild(
        chartBar(x, baseY - stoneH, barW, stoneH, "activity-bar activity-bar--stone", `${d.day}: ${d.stone} on-chain (stone)`),
      );
    }
    if (airH > 0) {
      svg.appendChild(
        chartBar(x, baseY - stoneH - airH, barW, airH, "activity-bar activity-bar--air", `${d.day}: ${d.air} pending (air)`),
      );
    }
  });

  // Label the first, middle, and last day along the x axis.
  const labelIdx = days.length <= 1 ? [0] : [0, Math.floor((days.length - 1) / 2), days.length - 1];
  [...new Set(labelIdx)].forEach((i) => {
    const day = days[i];
    if (!day) return;
    const x = pad.left + i * slot + slot / 2;
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("class", "activity-axis");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(H - 6));
    text.setAttribute("text-anchor", i === 0 ? "start" : i === days.length - 1 ? "end" : "middle");
    text.textContent = day.day.slice(5); // MM-DD
    svg.appendChild(text);
  });

  return svg;
}

// Format a pondus decimal for display (up to 3 dp, thousands-separated).
function fmtPondus(x) {
  return (Number(x) || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
}
function fmtInt(x) {
  return (Number(x) || 0).toLocaleString("en-US");
}

// Coerce a Pact numeric value — a plain number, `{ int: "n" }`, `{ decimal: "n" }`,
// or a numeric string — into a JS number (chainweb /local encodes these several ways).
function coercePactNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    if ("int" in v) return coercePactNum(v.int);
    if ("decimal" in v) return coercePactNum(v.decimal);
  }
  return 0;
}

// Parse an on-chain PythMetrics blob (hyphenated keys) into the app's camelCase shape.
function parsePythMetrics(m) {
  m = m || {};
  return {
    petitions: coercePactNum(m.petitions),
    pondus: coercePactNum(m.pondus),
    transactions: coercePactNum(m.transactions),
    gasReserved: coercePactNum(m["gas-reserved"]),
    failedTransactions: coercePactNum(m["failed-transactions"]),
    wastedGasReserved: coercePactNum(m["wasted-gas-reserved"]),
  };
}

// The Pyth ledger's day-1 anchor (UTC midnight) — UR_PythLedgerEpochStart. Day N =
// anchor + (N-1) days. Used to map on-chain integer day ordinals to date strings.
const PYTH_EPOCH_MS = Date.UTC(2026, 7, 1); // 2026-08-01
function pythDayToDateStr(ordinal) {
  return new Date(PYTH_EPOCH_MS + (coercePactNum(ordinal) - 1) * 86400000).toISOString().slice(0, 10);
}

// Read the ON-CHAIN Pyth ledger (the "stone" — what A_Flush has written): the running
// total (the STONE stat cards) + the flushed daily rows (the chart). Throws only if the
// TOTAL read fails (chain slow/down) so the caller can fall back to air-only.
//
// NOTE the daily read is per-day, NOT the batch `URD_ListPythDaily(from,to)` — that Pact
// helper maps a plain `read` over every day in the range and THROWS on the first gap
// ("No value found … for key: N"), because a day with no activity (e.g. day 1) has no
// row. So we read the recent chart window one day at a time and skip missing days; a gap
// no longer discards the whole on-chain read (the bug that showed stone = 0 despite a
// real flush).
async function loadPythChain() {
  const totalRaw = await pythiaRead(`(${PYTHIA_NS}.PYTHIA.UR_PythTotal)`);
  const lastDay = coercePactNum(totalRaw && totalRaw["last-day"]);
  const total = parsePythMetrics(totalRaw && totalRaw["total-metrics"]);
  let daily = [];
  if (lastDay >= 1) {
    const from = Math.max(1, lastDay - CHART_DAYS + 1);
    const ordinals = [];
    for (let d = from; d <= lastDay; d++) ordinals.push(d);
    const rows = await Promise.all(
      ordinals.map((d) =>
        pythiaRead(`(${PYTHIA_NS}.PYTHIA.UR_PythDay ${d})`).then(
          (row) => ({
            day: pythDayToDateStr(d),
            sealed: !!(row && row["iz-sealed"] === true),
            metrics: parsePythMetrics(row && row.metrics),
          }),
          () => null, // a day with no on-chain row (never flushed) — skip it
        ),
      ),
    );
    daily = rows.filter(Boolean);
  }
  return { total, daily, lastDay };
}

/** A legend swatch + label for the stone/air key. */
function pythLegendItem(kind, label) {
  const item = el("span", "pyth-legend-item");
  item.appendChild(el("span", `pyth-swatch pyth-swatch--${kind}`));
  item.appendChild(el("span", null, label));
  return item;
}

// A stat card showing the on-chain STONE value large + a translucent "+air" pending
// annotation (the local, not-yet-flushed backlog). Either side may be absent.
function stoneAirCard(label, stoneVal, airVal, fmt) {
  const card = el("div", "stat-card");
  const stoneN = Number(stoneVal) || 0;
  const airN = Number(airVal) || 0;
  card.appendChild(el("span", "stat-value", fmt(stoneN)));
  if (airN > 0) card.appendChild(el("span", "stat-air", `+ ${fmt(airN)} in air`));
  card.appendChild(el("span", "stat-label", label));
  return card;
}

// Merge on-chain daily (stone) + local daily (air) by date → [{ day, stone, air }].
function mergePythDaily(stoneDaily, airDaily) {
  const byDay = new Map();
  (stoneDaily || []).forEach((d) => {
    byDay.set(d.day, { day: d.day, stone: (d.metrics && d.metrics.petitions) || 0, air: 0 });
  });
  (airDaily || []).forEach((d) => {
    const e = byDay.get(d.day) || { day: d.day, stone: 0, air: 0 };
    e.air = d.petitions || 0;
    byDay.set(d.day, e);
  });
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Render the StoaChain Pyth ledger as STONE (written on-chain by A_Flush) + AIR
// (Pythia's local backlog, awaiting the next flush). Two colours: solid gold stone,
// translucent cyan air. Fleet-wide, keyless. `air`/`stone` are each nullable.
function renderPyth(container, air, stone) {
  container.textContent = "";
  const stoneTotal = (stone && stone.total) || null;
  const airTotal = (air && air.total) || null;

  const stoneEmpty =
    !stoneTotal ||
    (!stoneTotal.petitions &&
      !stoneTotal.transactions &&
      !stoneTotal.failedTransactions &&
      (!stone.daily || stone.daily.length === 0));
  const airEmpty =
    !airTotal ||
    (!airTotal.petitions &&
      !airTotal.transactions &&
      !airTotal.failedTransactions &&
      (!air.daily || air.daily.length === 0));
  if (stoneEmpty && airEmpty) {
    container.appendChild(
      el("p", "empty", "No activity yet — Petitions and Pondus accrue as Pythia serves keyed reads, and turn to stone on the next on-chain flush."),
    );
    return;
  }

  const legend = el("div", "pyth-legend");
  legend.appendChild(pythLegendItem("stone", "Stone — written on-chain (A_Flush)"));
  legend.appendChild(pythLegendItem("air", "Air — local, awaiting the next flush"));
  container.appendChild(legend);

  const headline = el("div", "stat-cards stat-cards--four");
  headline.appendChild(stoneAirCard("petitions", stoneTotal && stoneTotal.petitions, airTotal && airTotal.petitions, fmtInt));
  headline.appendChild(stoneAirCard("pondus", stoneTotal && stoneTotal.pondus, airTotal && airTotal.pondus, fmtPondus));
  headline.appendChild(stoneAirCard("transactions", stoneTotal && stoneTotal.transactions, airTotal && airTotal.transactions, fmtInt));
  headline.appendChild(stoneAirCard("gas reserved", stoneTotal && stoneTotal.gasReserved, airTotal && airTotal.gasReserved, fmtInt));
  container.appendChild(headline);

  const chartWrap = el("div", "stats-chart");
  chartWrap.appendChild(el("h4", "stats-sub", "Daily petitions — stone + air"));
  chartWrap.appendChild(buildActivityChart(mergePythDaily(stone && stone.daily, air && air.daily)));
  container.appendChild(chartWrap);

  const outs = el("div", "stat-cards stat-cards--two");
  outs.appendChild(stoneAirCard("failed transactions", stoneTotal && stoneTotal.failedTransactions, airTotal && airTotal.failedTransactions, fmtInt));
  outs.appendChild(stoneAirCard("wasted gas reserved", stoneTotal && stoneTotal.wastedGasReserved, airTotal && airTotal.wastedGasReserved, fmtInt));
  container.appendChild(outs);

  const foot = el("p", "pyth-foot");
  if (stone && stone.lastDay >= 1) {
    foot.textContent = `Written on-chain through day ${stone.lastDay} (${pythDayToDateStr(stone.lastDay)}). Air totals turn to stone on Pythia's next A_Flush.`;
  } else {
    foot.textContent = "Nothing written on-chain yet — all activity is still air, awaiting Pythia's first A_Flush.";
  }
  container.appendChild(foot);
}

// ── live pulse (Pythia's heartbeat) ──────────────────────────────────────────
// The fleet ledger (/pyth) updates in real time as Pythia serves reads and relays
// sends. While the Activity view is open we poll it every few seconds and bump the
// displayed numbers UP as activity arrives — a live demonstration of the pulse. It
// also shows the per-consumer transaction breakdown (byConsumer). This is a layer
// ABOVE the stone/air on-chain view, which is unchanged.
const PULSE_INTERVAL_MS = 4000;
let pythPulseTimer = null;
let pythPulseLast = {}; // last-seen fleet totals, for count-up deltas

const PULSE_KEYS = [
  { key: "petitions", label: "Petitions", fmt: fmtInt, round: true },
  { key: "pondus", label: "Pondus", fmt: fmtPondus, round: false },
  { key: "transactions", label: "Transactions", fmt: fmtInt, round: true },
];

function consumerLabel(name) {
  if (name === "pythia-self") return "Pythia (self)";
  if (name === "direct") return "Anonymous";
  // Keyed consumers resolve to their (long) Apollo account — ellipsize for display.
  if (typeof name === "string" && name.length > 22) return shortApollo(name);
  return name;
}

// Tween a number element from→to over ~0.6s (ease-out). `round` keeps integer
// counters whole during the animation; pondus animates with decimals.
function animatePulseNumber(node, from, to, fmt, round) {
  if (!node) return;
  const a = Number.isFinite(from) ? from : 0;
  const b = Number.isFinite(to) ? to : 0;
  if (a === b || typeof requestAnimationFrame !== "function") {
    node.textContent = fmt(b);
    return;
  }
  const dur = 600;
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = a + (b - a) * eased;
    node.textContent = fmt(round ? Math.round(v) : v);
    if (p < 1) requestAnimationFrame(step);
    else node.textContent = fmt(b);
  }
  requestAnimationFrame(step);
}

// Brief highlight "bump" — restart the CSS animation via a forced reflow.
function pulseBump(node) {
  if (!node) return;
  node.classList.remove("pulse-num--bump");
  void node.offsetWidth;
  node.classList.add("pulse-num--bump");
  setTimeout(() => node.classList.remove("pulse-num--bump"), 800);
}

// One compact metric cell (value + unit) for a consumer row.
function pulseMetric(value, unit, fmt) {
  const cell = el("span", "pulse-cmetric");
  cell.appendChild(el("span", "pulse-cval", fmt(value || 0)));
  cell.appendChild(el("span", "pulse-cunit", unit));
  return cell;
}

// Consumer-list pagination. 10/page keeps the Live Pulse list short so the eye
// finds a key fast; the graph now lives in its own Statistics sub-view so length
// here no longer buries it. Trivially switchable to 15.
const ACTIVITY_CONSUMER_PAGE_SIZE = 10;
let activityConsumerPage = 0;
let lastByConsumer = null; // last-rendered byConsumer, so a lane-map load can re-render in place

// Apollo-account → consumer-lane, built from the on-chain dual-link roster
// (URD_ListAllDualLinks). Both sides of a link map to the same lane so whichever
// side a byConsumer key matches resolves. Loaded on Activity entry (see below).
let consumerLaneByApollo = {};

function renderPulseConsumers(container, byConsumer) {
  container.textContent = "";
  lastByConsumer = byConsumer || null;
  const entries = Object.entries(byConsumer || {}).sort(
    // Most active first — reads + transactions combined.
    (a, b) =>
      (b[1].petitions || 0) + (b[1].transactions || 0) - ((a[1].petitions || 0) + (a[1].transactions || 0)),
  );
  if (!entries.length) {
    container.appendChild(
      el("p", "pulse-empty", "No activity attributed yet — petitions, pondus and transactions appear here per key as consumers read and fire."),
    );
    return;
  }
  container.appendChild(el("h4", "pulse-consumers-title", "Activity by consumer (per API key)"));
  // Clamp the page — the live list may have shrunk since the user last paged
  // (a consumer dropping off). Never reset to 0 on a refresh (§ live poll).
  const pageCount = Math.max(1, Math.ceil(entries.length / ACTIVITY_CONSUMER_PAGE_SIZE));
  if (activityConsumerPage >= pageCount) activityConsumerPage = pageCount - 1;
  if (activityConsumerPage < 0) activityConsumerPage = 0;
  const start = activityConsumerPage * ACTIVITY_CONSUMER_PAGE_SIZE;
  const slice = entries.slice(start, start + ACTIVITY_CONSUMER_PAGE_SIZE);
  const list = el("div", "pulse-clist");
  for (const [name, c] of slice) {
    const row = el("div", "pulse-crow");
    const nm = el("span", "pulse-cname", consumerLabel(name));
    nm.title = name; // full identifier on hover
    row.appendChild(nm);
    // Lane pill — the consumer's dual-link lane, when the key maps to one.
    // Empty / BAR sentinel → no lane (e.g. pythia-self, unmapped keys).
    const lane = consumerLaneByApollo[name];
    if (lane && lane !== BAR) row.appendChild(el("span", "pulse-clane", lane));
    const metrics = el("span", "pulse-cmetrics");
    metrics.appendChild(pulseMetric(c.petitions, "petitions", fmtInt));
    metrics.appendChild(pulseMetric(c.pondus, "pondus", fmtPondus));
    metrics.appendChild(pulseMetric(c.transactions, "tx", fmtInt));
    if (c.failedTransactions) metrics.appendChild(el("span", "pulse-cfail", `${fmtInt(c.failedTransactions)} failed`));
    row.appendChild(metrics);
    list.appendChild(row);
  }
  container.appendChild(list);
  // Prev/next + page indicator BELOW the list, only when it overflows one page.
  if (entries.length > ACTIVITY_CONSUMER_PAGE_SIZE) {
    const pager = el("div", "pulse-pager");
    renderPager(pager, activityConsumerPage, pageCount, (p) => {
      activityConsumerPage = p;
      renderPulseConsumers(container, byConsumer);
    });
    container.appendChild(pager);
  }
}

// Build the always-present pulse block from a /pyth response (may be null).
function buildPythPulse(pyth) {
  const total = (pyth && pyth.total) || {};
  const wrap = el("div", "pyth-pulse");
  wrap.id = "pyth-pulse";
  const head = el("div", "pulse-head");
  head.appendChild(el("span", "pulse-dot"));
  head.appendChild(el("span", "pulse-title", "Live pulse"));
  head.appendChild(el("span", "pulse-sub", "fleet ledger · updates live"));
  wrap.appendChild(head);
  const tiles = el("div", "pulse-tiles");
  for (const k of PULSE_KEYS) {
    const tile = el("div", "pulse-tile");
    const num = el("div", "pulse-num", k.fmt(total[k.key] || 0));
    num.dataset.pulse = k.key;
    tile.appendChild(num);
    tile.appendChild(el("div", "pulse-label", k.label));
    tiles.appendChild(tile);
  }
  wrap.appendChild(tiles);
  const consumers = el("div", "pulse-consumers");
  consumers.id = "pulse-consumers";
  renderPulseConsumers(consumers, pyth && pyth.byConsumer);
  wrap.appendChild(consumers);
  return wrap;
}

// One poll: fetch /pyth and update the pulse block in place — animate a count-up +
// bump on any counter that increased; refresh the per-consumer list.
async function pythPulseTick() {
  let pyth = null;
  try {
    const res = await fetch("/pyth", { headers: { accept: "application/json" } });
    if (res.ok) pyth = await res.json();
  } catch {
    return; // transient — try again next tick, leave the display as-is
  }
  if (!pyth) return;
  const block = document.getElementById("pyth-pulse");
  if (!block) return; // not on the Activity view / not rendered yet
  const total = pyth.total || {};
  for (const k of PULSE_KEYS) {
    const node = block.querySelector(`[data-pulse="${k.key}"]`);
    const prev = (pythPulseLast && pythPulseLast[k.key]) || 0;
    const next = total[k.key] || 0;
    if (next > prev) {
      animatePulseNumber(node, prev, next, k.fmt, k.round);
      pulseBump(node);
    } else if (node) {
      node.textContent = k.fmt(next);
    }
  }
  pythPulseLast = total;
  const cc = document.getElementById("pulse-consumers");
  if (cc) renderPulseConsumers(cc, pyth.byConsumer);
}

function startPythPulse() {
  stopPythPulse();
  if (typeof setInterval === "function") pythPulseTimer = setInterval(pythPulseTick, PULSE_INTERVAL_MS);
}
function stopPythPulse() {
  if (pythPulseTimer) {
    clearInterval(pythPulseTimer);
    pythPulseTimer = null;
  }
}

// The Activity body reads TWO sources: /pyth (the local unflushed backlog = "air")
// and the on-chain ledger via pythiaRead (the flushed data = "stone"). Each degrades
// independently — chain slow/down shows air only; local down shows stone only. The
// live pulse block (from /pyth) is rendered ABOVE the stone/air view and is the part
// the poll keeps ticking.
async function loadPyth() {
  // The pulse (live-pulse sub-view) and the stone/air view (statistics sub-view)
  // now live in separate wrappers — render each into its own body.
  const pulseBody = document.getElementById("pulse-body");
  const statsBody = document.getElementById("stats-body");
  if (!pulseBody || !statsBody) return;
  let air = null;
  let stone = null;
  try {
    const res = await fetch("/pyth", { headers: { accept: "application/json" } });
    if (res.ok) air = await res.json();
  } catch {
    /* air stays null */
  }
  try {
    stone = await loadPythChain();
  } catch {
    /* stone stays null — chain unavailable; air-only render */
  }
  // Live pulse — always present so the poll can bump it in place (fleet ledger).
  pulseBody.textContent = "";
  pulseBody.appendChild(buildPythPulse(air));
  pythPulseLast = (air && air.total) || {};
  // The on-chain stone/air view (unchanged) — now in the Statistics sub-view.
  statsBody.textContent = "";
  const onchain = el("div", "pyth-onchain");
  if (!air && !stone) {
    onchain.appendChild(el("p", "empty", "Ledger unavailable."));
  } else {
    renderPyth(onchain, air, stone);
  }
  statsBody.appendChild(onchain);
}

// ── top-level tabs (Chains / Activity / For developers / Connectors) ─────────
// The tier-1 section nav now lives in the Pantheonic Header (.ph-tier1). Each
// active section's tier-2 sub-navigation is mirrored into the header's .ph-l3
// row; sections without a sub-nav leave that row hidden (no empty band).
// Connectors' two tier-2 buttons delegate to the in-panel #conn-subtabs handler
// so the existing sub-view switch (incl. its lazy register load) is reused, not
// re-implemented.
// Each section's tier-2 sub-nav lives ONLY in the header's L3 row — there are no
// in-panel button rows at all. The header buttons ARE the controls: `select(key)`
// performs the switch directly; `active()` reads the section's own state truth.
let currentConnSub = "apikeys";
function showConnectorSubview(key) {
  currentConnSub = key;
  const panel = document.querySelector('[data-panel="connectors"]');
  if (!panel) return;
  panel.querySelectorAll("[data-subpanel]").forEach((p) => {
    p.hidden = p.dataset.subpanel !== key;
  });
  // Lazy-load the halves the first time Register opens; always refresh proven.
  if (key === "register") {
    if (!regState.loaded) loadHalves();
    loadProven();
  }
}

// StoaChain Activity has two tier-2 sub-views: Live Pulse (heartbeat tiles +
// consumer list) and Statistics (stone/air totals + daily graph). The URL picks
// one; showActivitySubview toggles which [data-activity-view] wrapper is shown.
// The pulse feeds both, so it runs whenever the section is on (either sub).
let currentActivitySub = "live-pulse";
function showActivitySubview(key) {
  currentActivitySub = key;
  const panel = document.querySelector('[data-panel="activity"]');
  if (!panel) return;
  panel.querySelectorAll("[data-activity-view]").forEach((v) => {
    v.hidden = v.dataset.activityView !== key;
  });
  // Both subs read from /pyth — (re)load the data and (re)arm the live heartbeat
  // on entry. startPythPulse() clears any prior timer first, so toggling is safe.
  loadPyth();
  startPythPulse();
  loadConsumerLanes(); // refresh the apollo→lane map for the consumer list (throttled)
}

// Foreign Blockchain Activity — one sub-view (Arweave) for now, a placeholder.
// No data yet, so this just records which sub is active (the panel is static).
let currentForeignSub = "arweave";
function showForeignSubview(key) {
  currentForeignSub = key;
}

// Build the apollo-account → consumer-lane map from the on-chain dual-link roster.
// Both sides of each link map to the same lane, so whichever side a byConsumer key
// matches resolves. Throttled: the roster changes rarely, so a single load-on-enter
// (plus a 60s floor between reloads) is plenty — never on the 4s pulse tick.
let consumerLaneLoadedAt = 0;
async function loadConsumerLanes(force) {
  const now = Date.now();
  if (!force && consumerLaneLoadedAt && now - consumerLaneLoadedAt < 60000) return;
  consumerLaneLoadedAt = now;
  try {
    const rows = await pythiaRead(`(${PYTHIA_NS}.PYTHIA.URD_ListAllDualLinks)`);
    const map = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const lane = r && r["consumer-lane"];
        if (!lane || lane === BAR) continue; // empty / sentinel → no lane
        if (r["standard-apollo"]) map[r["standard-apollo"]] = lane;
        if (r["smart-apollo"]) map[r["smart-apollo"]] = lane;
      }
    }
    consumerLaneByApollo = map;
    // Re-render the visible consumer list so lanes appear without waiting a tick.
    const cc = document.getElementById("pulse-consumers");
    if (cc && lastByConsumer) renderPulseConsumers(cc, lastByConsumer);
  } catch {
    /* leave the previous map in place on a failed read */
  }
}

const TIER2 = {
  chains: {
    items: () => CHAINS.map((c) => ({ key: c.id, label: c.name })),
    select: (key) => selectChain(key),
    active: () => currentChainId,
  },
  activity: {
    items: () => [
      { key: "live-pulse", label: "Live Pulse" },
      { key: "statistics", label: "Statistics" },
    ],
    select: (key) => showActivitySubview(key),
    active: () => currentActivitySub,
  },
  foreign: {
    items: () => [{ key: "arweave", label: "Arweave" }],
    select: (key) => showForeignSubview(key),
    active: () => currentForeignSub,
  },
  connectors: {
    items: () => [
      { key: "apikeys", label: "Full API Keys" },
      { key: "register", label: "Register / Link halves" },
    ],
    select: (key) => showConnectorSubview(key),
    active: () => currentConnSub,
  },
};

function renderTier2(name) {
  const nav = document.getElementById("ph-tier2");
  if (!nav) return;
  nav.textContent = "";
  // L3 is a FIXED zone — never hidden, so the header height stays constant. The
  // tier-2 buttons just fill into or empty out of it as sections are picked.
  const cfg = TIER2[name];
  if (!cfg) return;
  const items = cfg.items();
  const activeKey = cfg.active() || (items[0] && items[0].key);
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ph-btn ph-btn--ghost" + (item.key === activeKey ? " ph-btn--active" : "");
    btn.dataset.tier2 = item.key;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      goTo("#" + name + "/" + item.key); // the URL drives the sub-view switch (§3.7)
    });
    nav.appendChild(btn);
  }
}

// ── URL is the source of truth for the active view (§3.7 Pantheonic Architecture) ──
// Every Tier-1 section (#chains) and Tier-2 sub-view (#chains/stoachain) is its own
// deep-linkable, back-navigable URL. Nav controls set location.hash; the hash drives
// what renders — never in-memory panel flipping behind a static, opaque URL.
const SECTIONS = ["chains", "activity", "foreign", "connectors", "developers"];
const DEFAULT_SECTION = "chains";

function parseHash() {
  const [section, sub] = location.hash.replace(/^#/, "").split("/");
  return { section, sub };
}

// Navigate by URL: set the hash (fires hashchange → routeFromHash). When the hash is
// already the target (no event fires), route directly so the click still acts.
function goTo(hash) {
  if (location.hash === hash) routeFromHash();
  else location.hash = hash;
}

// The router: derive the shown section + sub-view FROM the URL. Runs on load and on
// every hashchange (Back/forward + programmatic nav), so the URL and the view can't drift.
function routeFromHash() {
  const { section, sub } = parseHash();
  showTab(SECTIONS.includes(section) ? section : DEFAULT_SECTION, sub);
}

function showTab(name, wantSub) {
  // Leaving the Activity section stops the live pulse poll (re-armed on re-entry by
  // showActivitySubview, which both subs share) — no polling while it's off-screen.
  if (name !== "activity") stopPythPulse();
  // Tier-1 section nav lives in the header (.ph-tier1); mark the active button.
  document.querySelectorAll(".ph-tier1 [data-tab]").forEach((t) => {
    t.classList.toggle("ph-btn--active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tabpanel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  // The work-area scrolls internally on the landing — reset it to the top so a
  // new section starts at its head, not wherever the previous one was scrolled.
  const wa = document.querySelector(".work-area");
  if (wa) wa.scrollTop = 0;

  // Apply the Tier-2 sub-view named in the URL (or the section's current/first).
  // Done BEFORE renderTier2 so its active-marking reads the state we just set.
  const cfg = TIER2[name];
  if (cfg) {
    const keys = cfg.items().map((i) => i.key);
    // A bare section URL (#connectors) resolves to its FIRST sub deterministically —
    // never to last-used in-memory state, so the same URL always renders the same view.
    const sub = wantSub && keys.includes(wantSub) ? wantSub : keys[0];
    if (sub) cfg.select(sub); // selectChain / showActivitySubview / showForeignSubview / showConnectorSubview
  }
  renderTier2(name); // repopulate the header's tier-2 sub-nav for this section

  // Section-entry loads not owned by a sub-view.
  if (name === "connectors") {
    loadDualLinks(); // default sub-tab; halves load lazily on the register tab
    if (regState.loaded) loadHalves();
    loadProven(); // refresh which halves are already verified this session
  }
}

function wireTabs() {
  document.querySelectorAll("[data-tab]").forEach((elm) => {
    elm.addEventListener("click", (e) => {
      if (elm.tagName === "A") e.preventDefault(); // hero CTAs are tab switchers
      goTo("#" + elm.dataset.tab); // the URL drives the switch (§3.7)
    });
  });
}

// ── portrait collapse toggle ─────────────────────────────────────────────────
// Collapse the right-hand Pythia portrait to give the work-area the full page
// width; the choice persists across visits (localStorage).
function wireArtToggle() {
  const stage = document.getElementById("stage");
  const btn = document.getElementById("art-toggle");
  if (!stage || !btn) return;
  const KEY = "pythia_art_collapsed";
  const apply = (collapsed) => {
    stage.classList.toggle("art-collapsed", collapsed);
    btn.textContent = collapsed ? "⇤" : "⇥";
    btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
    btn.setAttribute("aria-label", collapsed ? "Show the portrait" : "Collapse the portrait");
    btn.title = collapsed
      ? "Show the portrait"
      : "Collapse the portrait (give content full width)";
  };
  apply(localStorage.getItem(KEY) === "1");
  btn.addEventListener("click", () => {
    const collapsed = !stage.classList.contains("art-collapsed");
    localStorage.setItem(KEY, collapsed ? "1" : "0");
    apply(collapsed);
  });
}

// ── init ─────────────────────────────────────────────────────────────────────
wireTabs();
wireArtToggle();
wireConnectors();
startHealthPill();
loadMe(); // /api/me → renders the header (+ an Admin link for ancients → /admin)
loadPyth();
// The URL is the source of truth: derive the initial view from the hash, and re-derive
// on every hashchange (Back/forward + programmatic nav). Replaces the fixed default tab.
window.addEventListener("hashchange", routeFromHash);
routeFromHash();
resumePendingVerify(); // if we just came back from a verifier, restore + light up Link

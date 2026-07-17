// Pythia landing client — vanilla, framework-free, no bundler. The page is
// MODULAR per chain: `CHAINS` drives a chain selector, and each chain renders
// its own self-contained module (node pool + dirty-read console + endpoints).
// Adding a chain = adding one entry to CHAINS.

import { renderIdentity, setVersion } from "./pantheon-header.js";

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
let dlState = { filter: "all", search: "", page: 0, rows: [] };
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

function dualLinkRow(r) {
  const active = r["iz-active"] === true;
  const row = document.createElement("div");
  row.className = "dl-row" + (active ? "" : " dl-row--off");

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

  row.append(main, meta);
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
      if (sProven && mProven) { note.className = "link-ok"; note.textContent = " — both halves verified"; }
      else if (sProven || mProven) { note.className = "link-warn"; note.textContent = " — one half verified; verify the other (load the Codex that holds it)"; }
      sel.appendChild(note);
    }
  }

  const bothUnlinked = !!(s && m && isUnlinked(s.counterpart) && isUnlinked(m.counterpart));
  verifyBtn.disabled = !bothUnlinked;
  linkBtn.disabled = !(bothUnlinked && sProven && mProven);
  linkBtn.title = sProven && mProven
    ? "Submit the on-chain link"
    : "Unlocks once both halves are verified";
}

// Pull the proven set from the server and refresh the action bar.
async function loadProven() {
  try {
    const res = await fetch("/api/connectors/verify/status", {
      headers: { accept: "application/json" },
    });
    const body = await res.json();
    regState.proven = Array.isArray(body.proven) ? body.proven : [];
  } catch {
    /* keep the last-known set */
  }
  updateActionBar();
}

// Stage 1 — VERIFY ownership. Pythia is keyless, so it can't sign; this popup
// deep-links out to a wallet/Codex that holds the user's DALOS seed to prove
// ownership of BOTH halves. Once Pythia confirms the proof, the Link step (stage
// 2) unlocks. This popup does NOT submit the link itself.
function openVerifyPopup() {
  const s = regState.selStd;
  const m = regState.selSmart;
  if (!s || !m || !isUnlinked(s.counterpart) || !isUnlinked(m.counterpart)) return;
  const std = s["apollo-account"];
  const smart = m["apollo-account"];

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
      sessionStorage.setItem("pythia_verify_pending", JSON.stringify({ standard: std, smart }));
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
  done.addEventListener("click", () => { close(); loadProven(); loadHalves(); loadDualLinks(); });
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

  showTab("connectors");
  const regBtn = document.querySelector('#conn-subtabs [data-subtab="register"]');
  if (regBtn) regBtn.click(); // switch to the register sub-panel
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
function wireConnectors() {
  const panel = document.querySelector('[data-panel="connectors"]');
  if (!panel) return;
  wireSubtabs(document.getElementById("conn-subtabs"), panel);

  // Lazy-load the halves the first time the register sub-tab is opened; always
  // refresh the proven set so returning verifications reflect immediately.
  const regBtn = panel.querySelector('[data-subtab="register"]');
  if (regBtn) regBtn.addEventListener("click", () => { if (!regState.loaded) loadHalves(); loadProven(); });

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
    // Stage 2 — deferred. Only reachable once Pythia confirms ownership (the
    // button is disabled until then). Its real action — signalling the AncientHub
    // DALOS Automaton to submit the link tx — is wired later.
    linkBtn.addEventListener("click", () => {
      const status = document.getElementById("reg-status");
      if (status) status.textContent = "Link trigger not wired yet — this will signal the AncientHub DALOS Automaton to submit the link transaction.";
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
function selectChain(id) {
  document.querySelectorAll(".chain-tab").forEach((t) => {
    const on = t.dataset.chain === id;
    t.classList.toggle("chain-tab--active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  const chain = CHAINS.find((c) => c.id === id);
  if (chain) renderChainModule(chain);
}

function renderChainTabs() {
  const tabs = document.getElementById("chain-tabs");
  if (!tabs) return;
  tabs.textContent = "";
  CHAINS.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chain-tab" + (i === 0 ? " chain-tab--active" : "");
    btn.dataset.chain = c.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", i === 0 ? "true" : "false");

    const name = document.createElement("span");
    name.className = "chain-tab-name";
    name.textContent = c.name;
    const badge = document.createElement("span");
    badge.className = `chain-badge chain-badge--${c.status}`;
    badge.textContent = c.status === "live" ? "Live" : "Soon";

    btn.appendChild(name);
    btn.appendChild(badge);
    btn.addEventListener("click", () => selectChain(c.id));
    tabs.appendChild(btn);
  });
  selectChain(CHAINS[0].id);
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

// ── hub feed (ancient-only): activate the node-pool feed from the UI ──────────
function updateHubFeedTab() {
  const tabBtn = document.querySelector('[data-tab="hubfeed"]');
  if (tabBtn) tabBtn.hidden = !isAncient();
  if (isAncient()) {
    loadHubStatus();
    loadTxSenders();
  }
}

function renderHubStatus(el, s) {
  el.textContent = "";

  // Live health bullet: green (live + nodes), amber (reachable, none yet),
  // red (configured but failing), grey (off).
  const bullet = document.createElement("div");
  bullet.className = "hub-bullet";
  const dot = document.createElement("span");
  dot.className = "dot";
  let color = "grey";
  let text = "Feed off — reads use the Upload Pool";
  if (s.secretSet) {
    if (s.feedOk && (s.slots ?? 0) > 0) {
      color = "green";
      text = `Feed live — ${s.slots} hub node${s.slots === 1 ? "" : "s"} in the pool`;
    } else if (s.feedOk) {
      color = "amber";
      text = "Feed reachable — no nodes advertised yet";
    } else {
      color = "red";
      text = `Feed error — ${s.feedError || "unreachable"}`;
    }
  }
  dot.setAttribute("data-color", color);
  const btext = document.createElement("span");
  btext.textContent = text;
  bullet.append(dot, btext);
  el.appendChild(bullet);

  const line = (label, value, cls) => {
    const p = document.createElement("p");
    p.className = "hub-stat";
    const b = document.createElement("b");
    b.textContent = `${label}: `;
    const v = document.createElement("span");
    if (cls) v.className = cls;
    v.textContent = value;
    p.append(b, v);
    return p;
  };
  el.append(
    line("Secret source", s.fromSettings ? "admin UI" : s.secretSet ? "deploy env" : "—", "muted"),
    line("Pythia egress IP", s.egressIp || "detecting…", "muted"),
  );
  const ipNote = document.createElement("p");
  ipNote.className = "panel-note";
  ipNote.textContent =
    "Allowlist this egress IP on the hub (/hub/pythia-admin → IP allowlist), or the feed returns 403.";
  el.appendChild(ipNote);

  renderHubSecret(s);
}

// ── upload pool (dedicated signed-tx senders) ────────────────────────────────
async function loadTxSenders() {
  const container = document.getElementById("txsenders");
  if (!container) return;
  try {
    const res = await fetch("/admin/tx-senders", { headers: { accept: "application/json" } });
    if (!res.ok) {
      // Distinguish "auth lost" from a genuinely empty pool — a blank list must
      // not read as "no nodes" (the exact confusion the cookie bug caused).
      if (res.status === 401 || res.status === 403) {
        container.textContent = "";
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "Session expired — reload the page and sign in again to manage the Upload Pool.";
        container.appendChild(p);
      }
      return;
    }
    const body = await res.json();
    renderTxSenders(container, body.senders ?? []);
  } catch {
    /* ignore */
  }
}

function renderTxSenders(container, senders) {
  container.textContent = "";

  // Live entry count next to the list header.
  const countEl = document.getElementById("txsenders-count");
  if (countEl) {
    const seeds = senders.filter((s) => s.seed).length;
    countEl.textContent = senders.length
      ? `${senders.length} node${senders.length === 1 ? "" : "s"} · ${seeds} seed`
      : "";
  }

  if (!senders.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No upload-pool nodes — sends are disabled (503) until you add one.";
    container.appendChild(empty);
    return;
  }

  // Explorer-style: one compact row per entry. Seed nodes carry a gold badge and
  // have NO Remove button (permanent); admin-added nodes can be disabled/removed.
  for (const s of senders) {
    const row = document.createElement("div");
    row.className = "txrow" + (s.enabled ? "" : " txrow--off");

    const main = document.createElement("span");
    main.className = "txrow-main";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("data-color", s.enabled ? "green" : "grey");
    main.appendChild(dot);

    const label = document.createElement("b");
    label.className = "txrow-label";
    label.textContent = s.label || s.url;
    main.appendChild(label);

    if (s.seed) {
      const badge = document.createElement("span");
      badge.className = "ca-badge ca-badge--seed";
      badge.textContent = "seed";
      main.appendChild(badge);
    }
    if (!s.enabled) {
      const badge = document.createElement("span");
      badge.className = "ca-badge";
      badge.textContent = "disabled";
      main.appendChild(badge);
    }

    const url = document.createElement("span");
    url.className = "txrow-url";
    url.textContent = s.url;
    main.appendChild(url);

    const actions = document.createElement("span");
    actions.className = "txrow-actions";

    // Seed nodes are permanent AND permanently enabled — no Disable, no Remove.
    // They show only as fixed baseline entries. Admin nodes get both controls.
    if (s.seed) {
      const fixed = document.createElement("span");
      fixed.className = "txrow-fixed";
      fixed.textContent = "baked in";
      actions.appendChild(fixed);
    } else {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn btn--ghost btn--small";
      toggle.textContent = s.enabled ? "Disable" : "Enable";
      toggle.addEventListener("click", () => setTxSenderEnabled(s.id, !s.enabled));
      actions.appendChild(toggle);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--ghost btn--small btn--danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeTxSender(s.id, s.label || s.url));
      actions.appendChild(remove);
    }

    row.append(main, actions);
    container.appendChild(row);
  }
}

async function setTxSenderEnabled(id, enabled) {
  try {
    const res = await fetch(`/admin/tx-senders/${encodeURIComponent(id)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) loadTxSenders();
  } catch {
    /* ignore */
  }
}

async function removeTxSender(id, name) {
  if (!window.confirm(`Remove upload-pool node "${name}"? Sends will stop using it.`)) return;
  try {
    const res = await fetch(`/admin/tx-senders/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
    if (res.ok) loadTxSenders();
  } catch {
    /* ignore */
  }
}

function wireTxSenderForm() {
  const form = document.getElementById("txsender-form");
  const err = document.getElementById("txsender-error");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const data = new FormData(form);
    const payload = {
      url: (data.get("url") || "").toString().trim(),
      label: (data.get("label") || "").toString().trim(),
    };
    if (!payload.url) return;
    try {
      const res = await fetch("/admin/tx-senders", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) { err.textContent = body.error || "Could not add the node."; err.hidden = false; }
        return;
      }
      form.reset();
      loadTxSenders();
    } catch {
      if (err) { err.textContent = "Network error adding the node."; err.hidden = false; }
    }
  });
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

// The Hub-feed panel's two sub-tabs (Observation | Upload), scoped to its section.
function wireHubSubtabs() {
  wireSubtabs(
    document.getElementById("hub-subtabs"),
    document.querySelector('[data-panel="hubfeed"]'),
  );
}

// Bulk-add Upload senders: one URL per line, POSTed one-by-one (reusing the
// single-add endpoint) so each is validated + deduped server-side.
function wireTxSenderBulk() {
  const form = document.getElementById("txsender-bulk-form");
  const err = document.getElementById("txsender-bulk-error");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const raw = (new FormData(form).get("urls") || "").toString();
    const urls = raw
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (!urls.length) return;
    let added = 0;
    let failed = 0;
    for (const url of urls) {
      try {
        const res = await fetch("/admin/tx-senders", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ url, label: "" }),
        });
        if (res.ok) added += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    form.reset();
    loadTxSenders();
    if (err) {
      err.textContent = failed
        ? `${added} added · ${failed} failed (bad URL or duplicate).`
        : `${added} added.`;
      err.hidden = false;
    }
  });
}

// When a secret is set, show it (masked) beneath the field with a Copy button
// that fetches the full value on demand (ancient-gated reveal).
function renderHubSecret(s) {
  const box = document.getElementById("hub-secret-current");
  if (!box) return;
  box.textContent = "";
  if (!s || !s.secretSet) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const label = document.createElement("span");
  label.className = "secret-label";
  label.textContent = `Secret set · ${s.secretMask || "••••"}`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn--small";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      const res = await fetch("/admin/hub-config/secret", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const body = await res.json();
      if (body.secret && navigator.clipboard) {
        await navigator.clipboard.writeText(body.secret);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      }
    } catch {
      /* ignore */
    }
  });
  box.append(label, copy);
}

async function loadHubStatus() {
  const el = document.getElementById("hub-status");
  const form = document.getElementById("hub-config-form");
  if (!el) return;
  try {
    const res = await fetch("/admin/hub-config", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const s = await res.json();
    renderHubStatus(el, s);
    const urlInput = form && form.querySelector('[name="hubBaseUrl"]');
    if (urlInput && !urlInput.value) urlInput.value = s.hubBaseUrl || "";
  } catch {
    /* leave empty */
  }
}

function wireHubConfig() {
  const form = document.getElementById("hub-config-form");
  const refresh = document.getElementById("hub-refresh");
  const err = document.getElementById("hub-config-error");
  const status = document.getElementById("hub-status");
  if (!form) return;

  // Show/hide toggle for the secret field.
  const toggle = document.getElementById("hub-secret-toggle");
  const secretInput = form.querySelector('[name="hmacSecret"]');
  if (toggle && secretInput) {
    toggle.addEventListener("click", () => {
      const reveal = secretInput.type === "password";
      secretInput.type = reveal ? "text" : "password";
      toggle.textContent = reveal ? "hide" : "show";
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const data = new FormData(form);
    const payload = { hubBaseUrl: (data.get("hubBaseUrl") || "").toString().trim() };
    const secret = (data.get("hmacSecret") || "").toString();
    if (secret) payload.hmacSecret = secret; // write-only: only sent when provided
    try {
      const res = await fetch("/admin/hub-config", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const s = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) { err.textContent = s.error || "Could not save the hub config."; err.hidden = false; }
        return;
      }
      const secretInput = form.querySelector('[name="hmacSecret"]');
      if (secretInput) secretInput.value = "";
      if (status) renderHubStatus(status, s);
    } catch {
      if (err) { err.textContent = "Network error saving the hub config."; err.hidden = false; }
    }
  });

  if (refresh) {
    refresh.addEventListener("click", async () => {
      try {
        const res = await fetch("/admin/hub-config/refresh", { method: "POST", headers: { accept: "application/json" } });
        if (res.ok && status) renderHubStatus(status, await res.json());
      } catch {
        /* ignore */
      }
    });
  }
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

function statNumber(label, value) {
  const card = el("div", "stat-card");
  card.appendChild(el("span", "stat-value", String(value)));
  card.appendChild(el("span", "stat-label", label));
  return card;
}

// Expand the (gap-filled) daily series to exactly `n` days ending today, so the
// chart always has a consistent axis — one narrow bar per day, today at the right,
// even when there's only a single day of data so far.
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
    out.push({ day: key, requests: rec ? rec.requests : 0 });
  }
  return out;
}

// A vanilla SVG bar chart of daily request counts — no chart library. Bars scale
// to the busiest day; a few evenly-spaced dates are labelled along the axis.
function buildActivityChart(daily) {
  const days = padDays(daily, CHART_DAYS);
  const W = 640;
  const H = 160;
  const pad = { top: 8, right: 8, bottom: 20, left: 8 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = days.reduce((m, d) => Math.max(m, d.requests), 0) || 1;
  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(slot * 0.68, 20));

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "activity-chart");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Daily requests over the last ${days.length} days`);

  days.forEach((d, i) => {
    const h = (d.requests / max) * plotH;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const y = pad.top + (plotH - h);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "activity-bar");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barW));
    rect.setAttribute("height", String(Math.max(0, h)));
    rect.setAttribute("rx", "1.5");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${d.day}: ${d.requests} request${d.requests === 1 ? "" : "s"}`;
    rect.appendChild(title);
    svg.appendChild(rect);
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

function buildConsumerTable(byConsumer) {
  const entries = Object.entries(byConsumer).sort((a, b) => b[1] - a[1]);
  const table = el("table", "stats-table");
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", null, "Consumer"));
  const thn = el("th", "num", "Requests");
  hr.appendChild(thn);
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const [name, count] of entries) {
    const tr = el("tr");
    tr.appendChild(el("td", null, name));
    tr.appendChild(el("td", "num", String(count)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderStats(container, stats) {
  container.textContent = "";
  const totals = stats.totals || { requests: 0, read: 0, send: 0, poll: 0, errors: 0 };

  if (!stats.since || totals.requests === 0) {
    container.appendChild(el("p", "empty", "No activity yet."));
    return;
  }

  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const today = daily.length ? daily[daily.length - 1].requests : 0;

  const headline = el("div", "stat-cards");
  headline.appendChild(statNumber("total requests", totals.requests));
  headline.appendChild(statNumber("requests today", today));
  headline.appendChild(statNumber("errors", totals.errors));
  container.appendChild(headline);

  const chartWrap = el("div", "stats-chart");
  chartWrap.appendChild(el("h4", "stats-sub", "Daily requests"));
  chartWrap.appendChild(buildActivityChart(daily));
  container.appendChild(chartWrap);

  const verbs = el("div", "stat-cards stat-cards--verbs");
  verbs.appendChild(statNumber("read", totals.read));
  verbs.appendChild(statNumber("send", totals.send));
  verbs.appendChild(statNumber("poll", totals.poll));
  container.appendChild(verbs);

  const byConsumer = stats.byConsumer || {};
  if (Object.keys(byConsumer).length > 0) {
    const cWrap = el("div", "stats-consumers");
    cWrap.appendChild(el("h4", "stats-sub", "By consumer"));
    cWrap.appendChild(buildConsumerTable(byConsumer));
    container.appendChild(cWrap);
  }
}

async function loadStats() {
  const container = document.getElementById("stats-body");
  if (!container) return;
  try {
    const res = await fetch("/stats", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderStats(container, await res.json());
  } catch {
    container.textContent = "";
    container.appendChild(el("p", "empty", "Stats unavailable."));
  }
}

// ── top-level tabs (Chains / Activity / For developers / Connectors) ─────────
// The tier-1 section nav now lives in the Pantheonic Header (.ph-tier1). Each
// active section's tier-2 sub-navigation is mirrored into the header's .ph-l3
// row; sections without a sub-nav leave that row hidden (no empty band).
// Connectors' two tier-2 buttons delegate to the in-panel #conn-subtabs handler
// so the existing sub-view switch (incl. its lazy register load) is reused, not
// re-implemented.
const TIER2 = {
  connectors: [
    { subtab: "apikeys", label: "Full API Keys" },
    { subtab: "register", label: "Register / Link halves" },
  ],
};

function renderTier2(name) {
  const row = document.getElementById("ph-l3");
  const nav = document.getElementById("ph-tier2");
  if (!row || !nav) return;
  nav.textContent = "";
  const items = TIER2[name] || [];
  // L3 is a FIXED zone — never hidden, so the header height stays constant. The
  // tier-2 buttons just fill into or empty out of it as sections are picked.
  if (!items.length) return;
  // Reflect whichever in-panel sub-tab is currently active (default: the first).
  const activeSub = document.querySelector("#conn-subtabs .subtab--active");
  const activeName = activeSub ? activeSub.dataset.subtab : items[0].subtab;
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ph-btn ph-btn--ghost" + (item.subtab === activeName ? " ph-btn--active" : "");
    btn.dataset.tier2 = item.subtab;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      // Delegate to the existing in-panel sub-tab switch (same handler wireSubtabs
      // bound), then mirror the active state onto the header buttons.
      const target = document.querySelector(`#conn-subtabs [data-subtab="${item.subtab}"]`);
      if (target) target.click();
      nav.querySelectorAll("[data-tier2]").forEach((b) => b.classList.toggle("ph-btn--active", b === btn));
    });
    nav.appendChild(btn);
  }
}

function showTab(name) {
  // Tier-1 section nav lives in the header (.ph-tier1); mark the active button.
  document.querySelectorAll(".ph-tier1 [data-tab]").forEach((t) => {
    t.classList.toggle("ph-btn--active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tabpanel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  renderTier2(name); // repopulate the header's tier-2 sub-nav for this section
  // The work-area scrolls internally on the landing — reset it to the top so a
  // new section starts at its head, not wherever the previous one was scrolled.
  const wa = document.querySelector(".work-area");
  if (wa) wa.scrollTop = 0;
  if (name === "activity") loadStats(); // refresh usage each time it's opened
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
      showTab(elm.dataset.tab);
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
renderChainTabs();
startHealthPill();
loadMe(); // /api/me → renders the header (+ an Admin link for ancients → /admin)
loadStats();
showTab("chains");
resumePendingVerify(); // if we just came back from a verifier, restore + light up Link

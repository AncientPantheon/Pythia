// Pythia Admin dashboard — the dedicated ancient-gated surface at /admin. Houses
// the gated functions that used to be the landing's "Hub feed" tab (Observation
// Pool + Upload Pool) plus the new Verifier registry. The page gates ITSELF on
// GET /api/me (the mutations all hit ancient-gated /admin/* APIs), so serving the
// shell to anyone is safe.

import { renderIdentity, setVersion, confirmDialog } from "./pantheon-header.js";

// ── auth / session ───────────────────────────────────────────────────────────
// `null` until GET /api/me resolves (the gate's "checking…" state); an object
// afterwards.
let authState = null;

function isAncient() {
  return !!(authState && authState.authenticated && authState.roles.includes("ancient"));
}

// The identity block is the shared Pantheonic Header renderer. Admin variant:
// no "Admin" link (we're already inside /admin).
function renderAuthbox() {
  renderIdentity(document.getElementById("authbox"), authState, { adminLink: false });
}

// The brand's version chip, read once from /healthz on load.
async function loadVersion() {
  try {
    const res = await fetch("/healthz", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = await res.json();
    setVersion(document.getElementById("ph-version"), body.version);
  } catch {
    /* leave the chip empty */
  }
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
  applyGate();
}

// ── admin gate + sidebar + hash router ───────────────────────────────────────
// The shared gate owns four states, driven purely by `authState`:
//   • authState === null           → "checking…" (before /api/me resolves)
//   • not authenticated            → a login prompt
//   • authenticated, not ancient   → a "requires the ancient role" notice
//   • ancient                      → the sidebar + content pane (hash-routed)
// This is UX only — every /admin/* mutation is gated again server-side.
function applyGate() {
  const body = document.getElementById("admin-body");
  const gate = document.getElementById("admin-gate");

  if (isAncient()) {
    if (gate) { gate.hidden = true; gate.textContent = ""; }
    if (body) body.hidden = false;
    renderSidebar();
    renderChains();
    routeFromHash();
    return;
  }

  if (body) body.hidden = true;
  if (!gate) return;
  gate.hidden = false;
  gate.textContent = "";

  if (authState === null) {
    const p = document.createElement("p");
    p.className = "panel-note";
    p.textContent = "Checking your session…";
    gate.appendChild(p);
    return;
  }

  const p = document.createElement("p");
  p.className = "panel-note";
  p.textContent = authState.authenticated
    ? "Your role can't access the admin dashboard — the ancient role is required."
    : "Sign in as an ancient admin to access the dashboard.";
  const login = document.createElement("a");
  login.className = "btn btn--primary";
  login.href = "/admin/login";
  login.textContent = authState.authenticated ? "Switch account" : "Log in";
  gate.append(p, login);
}

// The top-level sections rendered as the persistent sidebar menu. Enabled items
// hash-route into their view; disabled ("planned") items are greyed and inert.
const TILES = [
  {
    id: "verifiers",
    icon: "🔐",
    title: "Verifiers",
    blurb: "The Apollo-ownership sites the Connectors Verify popup offers.",
    hash: "#verifiers",
    enabled: true,
  },
  {
    id: "connectors",
    icon: "⛓️",
    title: "Blockchain Connectors",
    blurb: "Per-chain connector settings — read/send pools and routing, chain by chain.",
    hash: "#connectors",
    enabled: true,
  },
  {
    id: "update-deploy",
    icon: "⬆️",
    title: "Update & Deploy",
    blurb: "Live version + seed-pair health, plus the on-box blue-green deploy.",
    hash: "#update-deploy",
    enabled: true,
  },
  {
    id: "earnings",
    icon: "📜",
    title: "StoaChain Earnings",
    blurb: "The Pyth ledger — Petitions & Pondus served — plus reset and hub reporting.",
    hash: "#earnings",
    enabled: true,
  },
  {
    id: "pyth-flush",
    icon: "📤",
    title: "Pyth Flush",
    blurb: "Live per-day entries awaiting the on-chain A_Flush — what would go on chain now.",
    hash: "#pyth-flush",
    enabled: true,
  },
  {
    id: "security",
    icon: "🔑",
    title: "Security",
    blurb: "Sealed-credential vault — the hub secret, encrypted at rest.",
    hash: "#security",
    enabled: true,
  },
  {
    id: "codex",
    icon: "📓",
    title: "Codex",
    blurb: "Pythia's sovereign key vault — add/load keys, download & reload, sealed at rest.",
    hash: "#codex",
    enabled: true,
  },
  {
    id: "khronoton",
    icon: "⏳",
    title: "Khronoton",
    blurb: "Scheduled autonomous signing — set the cronotons Pythia fires on-chain, gas-station-paid.",
    hash: "#khronoton",
    enabled: true,
  },
];

// The chains the Blockchain Connectors list offers (future chains slot in here).
const CHAINS = [
  {
    id: "stoachain",
    icon: "🏛️",
    title: "StoaChain",
    blurb: "Observation Pool (hub-fed reads) + Upload Pool (signed-tx senders).",
    hash: "#connectors/stoachain",
    enabled: true,
  },
  {
    id: "arweave",
    icon: "🧵",
    title: "Arweave",
    blurb: "Permanent-storage connector — permaweb reads and uploads.",
    badge: "coming soon",
    enabled: false,
  },
];

// Views the hash router knows how to open (map to their load* function). Keys are
// the FULL nested names, matching the sections' data-view values exactly.
const VIEW_LOADERS = {
  verifiers: loadVerifiers,
  connectors: () => {}, // static chain list — rendered up front, nothing to load
  "connectors/stoachain": () => {
    loadHubStatus();
    loadHubNodes();
    loadTxSenders();
    renderStoachainRules();
  },
  "update-deploy": () => {
    loadVersionNetwork();
    loadDeployStatus();
  },
  earnings: loadEarnings,
  "pyth-flush": loadPythFlush,
  security: loadSecurity,
  codex: loadCodexIsland,
  khronoton: loadKhronotonIsland,
};

// Legacy (topic-2) flat hashes → their new nested homes, so old bookmarks land.
const LEGACY_HASHES = {
  observation: "connectors/stoachain",
  upload: "connectors/stoachain",
  version: "update-deploy",
};

// ── subhead (the description/tooltip zone beneath the header) ─────────────────
// The default prompt shown at bare /admin, and while hovering nothing.
const DEFAULT_HINT = "Select a section from the left to begin.";

// The active section's blurb, so a nav mouseleave restores it (not the hover one).
let currentBlurb = "";

function currentSectionBlurb() {
  return currentBlurb;
}

// Sets the subhead text; an empty string falls back to the default hint.
function setSubhead(text) {
  const el = document.getElementById("subhead-text");
  if (!el) return;
  el.textContent = text || DEFAULT_HINT;
}

// The blurb for a routed hash name: a chain's own blurb for a nested chain page
// (e.g. connectors/stoachain), else the top-level section's blurb from TILES.
function blurbForName(name) {
  const chain = CHAINS.find((c) => c.hash === "#" + name);
  if (chain) return chain.blurb;
  const topLevel = name.split("/")[0];
  const tile = TILES.find((t) => t.id === topLevel);
  return tile ? tile.blurb : "";
}

// Shared lined-entry builder: the landing tiles and the chain list use the same
// .admin-tiles/.tile markup idiom.
function renderEntryTiles(grid, entries) {
  grid.textContent = "";
  for (const t of entries) {
    const tile = document.createElement(t.enabled ? "a" : "button");
    tile.className = "tile" + (t.enabled ? "" : " tile--planned");
    if (t.enabled) {
      tile.href = t.hash;
    } else {
      tile.type = "button";
      tile.addEventListener("click", () => showPlannedNote(t.title));
    }

    const icon = document.createElement("span");
    icon.className = "tile-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = t.icon;

    const bodyEl = document.createElement("span");
    bodyEl.className = "tile-body";
    const title = document.createElement("span");
    title.className = "tile-title";
    title.textContent = t.title;
    const blurb = document.createElement("span");
    blurb.className = "tile-blurb";
    blurb.textContent = t.blurb;
    bodyEl.append(title, blurb);
    if (!t.enabled) {
      const badge = document.createElement("span");
      badge.className = "tile-badge";
      badge.textContent = t.badge || "planned";
      bodyEl.appendChild(badge);
    }

    tile.append(icon, bodyEl);
    grid.appendChild(tile);
  }
}

// The persistent sidebar: one .admin-nav-item row per top-level section (icon +
// label). Enabled → an <a href=hash>; planned → an inert button that posts the
// "coming later" note in the pane. Rendered once when the gate opens.
function renderSidebar() {
  const nav = document.getElementById("admin-sidebar");
  if (!nav) return;
  nav.textContent = "";
  for (const t of TILES) {
    const item = document.createElement(t.enabled ? "a" : "button");
    item.className = "admin-nav-item" + (t.enabled ? "" : " admin-nav-item--planned");
    item.dataset.navId = t.id;
    if (t.enabled) {
      item.href = t.hash;
    } else {
      item.type = "button";
      item.addEventListener("click", () => showPlannedNote(t.title));
    }

    const icon = document.createElement("span");
    icon.className = "admin-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = t.icon;

    const label = document.createElement("span");
    label.className = "admin-nav-label";
    label.textContent = t.title;

    // Hover feeds the item's blurb into the subhead zone; leaving restores the
    // active section's blurb (or the default hint).
    item.addEventListener("mouseenter", () => setSubhead(t.blurb));
    item.addEventListener("mouseleave", () => setSubhead(currentSectionBlurb()));

    item.append(icon, label);
    nav.appendChild(item);
  }
}

function renderChains() {
  const grid = document.getElementById("admin-chains");
  if (grid) renderEntryTiles(grid, CHAINS);
}

// A disabled section just posts a short note in the pane — never a view, never a
// backend call.
function showPlannedNote(title) {
  const note = document.getElementById("admin-tile-note");
  if (!note) return;
  note.textContent = `${title} is coming in a later round.`;
  note.hidden = false;
}

// Hash router: no (known) hash → no active nav + the default hint in the subhead +
// all views hidden; a known name (flat like #verifiers or nested like
// #connectors/stoachain) → that view in the pane + its top-level sidebar item
// marked active + its blurb in the subhead, firing its load* function so data
// shows on open. Legacy topic-2 hashes redirect first.
function routeFromHash() {
  if (!isAncient()) return;
  const name = location.hash.replace(/^#/, "");
  if (Object.prototype.hasOwnProperty.call(LEGACY_HASHES, name)) {
    location.hash = "#" + LEGACY_HASHES[name]; // hashchange re-fires the router
    return;
  }
  const known = Object.prototype.hasOwnProperty.call(VIEW_LOADERS, name);
  const note = document.getElementById("admin-tile-note");
  const views = document.querySelectorAll(".admin-view");
  const navItems = document.querySelectorAll(".admin-nav-item");

  if (known) {
    if (note) note.hidden = true;
    views.forEach((v) => { v.hidden = v.dataset.view !== name; });
    // Nested (#connectors/stoachain) highlights its top-level (connectors) item.
    const topLevel = name.split("/")[0];
    navItems.forEach((it) => {
      it.classList.toggle("admin-nav-item--active", it.dataset.navId === topLevel);
    });
    currentBlurb = blurbForName(name);
    setSubhead(currentBlurb);
    VIEW_LOADERS[name]();
  } else {
    if (note) note.hidden = true;
    views.forEach((v) => { v.hidden = true; });
    navItems.forEach((it) => it.classList.remove("admin-nav-item--active"));
    currentBlurb = "";
    setSubhead("");
  }
}

// Clears the hash to return to the unselected /admin state (which fires the
// router); nested views' back controls carry a data-back="#…" target instead.
function goToLanding() {
  if (location.hash) {
    location.hash = "";
  } else {
    routeFromHash();
  }
}

// ── chain-page sub-tabs (Observation Pool | Upload Pool | Routing Rules) ──────
// The classic subtab pattern, scoped to the StoaChain chain page: a clicked
// .subtab gets .subtab--active and the [data-subpanel] whose name matches its
// data-subtab is shown, the others hidden. Purely visual — the panels' contents
// stay in the DOM (IDs untouched), so the pool actions keep working as before.
function wireChainSubtabs() {
  const page = document.querySelector('.admin-view[data-view="connectors/stoachain"]');
  if (!page) return;
  const tabs = page.querySelectorAll(".subtab");
  const panels = page.querySelectorAll("[data-subpanel]");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.toggle("subtab--active", t === tab));
      panels.forEach((p) => { p.hidden = p.dataset.subpanel !== tab.dataset.subtab; });
    });
  });
}

// ── verifiers (the Apollo-ownership verify locations the Verify popup offers) ──
async function loadVerifiers() {
  const container = document.getElementById("verifiers-list");
  if (!container) return;
  try {
    const res = await fetch("/admin/verifiers", { headers: { accept: "application/json" } });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        container.textContent = "";
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "Session expired — reload and sign in again to manage verifiers.";
        container.appendChild(p);
      }
      return;
    }
    const body = await res.json();
    renderVerifiers(container, body.verifiers ?? []);
  } catch {
    /* ignore */
  }
}

function renderVerifiers(container, verifiers) {
  container.textContent = "";
  const countEl = document.getElementById("verifiers-count");
  if (countEl) {
    countEl.textContent = verifiers.length
      ? `${verifiers.length} verifier${verifiers.length === 1 ? "" : "s"}`
      : "";
  }
  if (!verifiers.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No verifiers yet — add the wallet/Codex sites that hold your consumers' Apollo keys. Until you add one, the Connectors Verify popup offers none.";
    container.appendChild(p);
    return;
  }
  for (const v of verifiers) {
    const row = document.createElement("div");
    row.className = "txrow" + (v.enabled ? "" : " txrow--off");

    const main = document.createElement("span");
    main.className = "txrow-main";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("data-color", v.enabled ? "green" : "grey");
    main.appendChild(dot);
    const label = document.createElement("b");
    label.className = "txrow-label";
    label.textContent = v.label;
    main.appendChild(label);
    if (!v.enabled) {
      const badge = document.createElement("span");
      badge.className = "ca-badge";
      badge.textContent = "disabled";
      main.appendChild(badge);
    }
    const url = document.createElement("span");
    url.className = "txrow-url";
    url.textContent = v.baseUrl;
    main.appendChild(url);

    const actions = document.createElement("span");
    actions.className = "txrow-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn btn--ghost btn--small";
    toggle.textContent = v.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", () => setVerifierEnabled(v.id, !v.enabled));
    actions.appendChild(toggle);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--ghost btn--small btn--danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeVerifier(v.id, v.label));
    actions.appendChild(remove);

    row.append(main, actions);
    container.appendChild(row);
  }
}

async function setVerifierEnabled(id, enabled) {
  try {
    const res = await fetch(`/admin/verifiers/${encodeURIComponent(id)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) loadVerifiers();
  } catch {
    /* ignore */
  }
}

async function removeVerifier(id, name) {
  const ok = await confirmDialog({
    title: "Remove verifier?",
    message: `"${name}" will no longer be offered in the Connectors Verify popup.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/admin/verifiers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
    if (res.ok) loadVerifiers();
  } catch {
    /* ignore */
  }
}

function wireVerifierForm() {
  const form = document.getElementById("verifier-form");
  const err = document.getElementById("verifier-error");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const data = new FormData(form);
    const payload = {
      label: (data.get("label") || "").toString().trim(),
      baseUrl: (data.get("baseUrl") || "").toString().trim(),
    };
    if (!payload.label || !payload.baseUrl) return;
    try {
      const res = await fetch("/admin/verifiers", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) { err.textContent = body.error || "Could not add the verifier."; err.hidden = false; }
        return;
      }
      form.reset();
      loadVerifiers();
    } catch {
      if (err) { err.textContent = "Network error adding the verifier."; err.hidden = false; }
    }
  });
}

// ── hub feed (Observation Pool) — moved verbatim from the old landing tab ──────
function renderHubStatus(el, s) {
  el.textContent = "";
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

// ── Observation Pool: the advertised hub fleet, probed for reachability ─────────
// True when the hub has started returning per-node earnings (graceful degrade).
function nodeHasEarnings(n) {
  return (
    n.slotStoicismEarned != null ||
    n.slotRewardedRequests != null ||
    n.operatorPythXP != null ||
    n.operatorPythLevel != null
  );
}

function renderHubNodes(el, nodes) {
  el.textContent = "";
  if (!Array.isArray(nodes) || nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-note";
    empty.textContent = "No hub nodes advertised — the feed is off/down, or the hub is serving none.";
    el.appendChild(empty);
    return;
  }
  for (const n of nodes) {
    const row = document.createElement("div");
    row.className = "hubnode" + (n.reachable ? "" : " hubnode--down");

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("data-color", n.reachable ? "green" : "red");
    dot.title = n.reachable ? "reachable" : `unreachable — ${n.reason || "unknown"}`;

    const main = document.createElement("span");
    main.className = "hubnode-main";
    const ip = document.createElement("span");
    ip.className = "hubnode-ip";
    ip.textContent = n.id;
    const url = document.createElement("span");
    url.className = "hubnode-url";
    url.textContent = n.url;
    main.append(ip, url);

    const meta = document.createElement("span");
    meta.className = "hubnode-meta";
    const op = document.createElement("span");
    op.className = "hubnode-op";
    op.textContent = n.operator || "—";
    if (n.operator) op.title = n.operator; // full value on hover — it may be long
    const tip = document.createElement("span");
    tip.className = "hubnode-tip" + (n.atTip ? "" : " hubnode-tip--behind");
    tip.textContent = n.atTip ? "at tip" : "behind";
    meta.append(op, tip);
    if (!n.reachable) {
      const why = document.createElement("span");
      why.className = "hubnode-reason";
      why.textContent = n.reason || "unreachable";
      meta.appendChild(why);
    }

    const earn = document.createElement("span");
    earn.className = "hubnode-earn";
    if (nodeHasEarnings(n)) {
      const bits = [];
      if (n.operatorPythLevel != null) bits.push(`L${n.operatorPythLevel}`);
      if (n.operatorPythXP != null) bits.push(`${Number(n.operatorPythXP).toLocaleString("en-US")} XP`);
      if (n.slotStoicismEarned != null) bits.push(`${n.slotStoicismEarned} STOIC`);
      earn.textContent = bits.join(" · ") || "—";
    } else {
      earn.className += " hubnode-earn--pending";
      earn.textContent = "awaiting hub";
    }

    row.append(dot, main, meta, earn);
    el.appendChild(row);
  }
}

async function loadHubNodes() {
  const el = document.getElementById("hub-nodes");
  if (!el) return;
  try {
    const res = await fetch("/admin/hub-nodes", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    renderHubNodes(el, await res.json());
  } catch {
    /* leave as-is */
  }
}

function wireHubConfig() {
  const form = document.getElementById("hub-config-form");
  const refresh = document.getElementById("hub-refresh");
  const err = document.getElementById("hub-config-error");
  const status = document.getElementById("hub-status");
  if (!form) return;

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
    if (secret) payload.hmacSecret = secret;
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
      const si = form.querySelector('[name="hmacSecret"]');
      if (si) si.value = "";
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
        loadHubNodes(); // re-probe the fleet after a feed refresh
      } catch {
        /* ignore */
      }
    });
  }
}

// ── upload pool (dedicated signed-tx senders) — moved verbatim ────────────────
async function loadTxSenders() {
  const container = document.getElementById("txsenders");
  if (!container) return;
  try {
    const res = await fetch("/admin/tx-senders", { headers: { accept: "application/json" } });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        container.textContent = "";
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "Session expired — reload and sign in again to manage the Upload Pool.";
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
  const ok = await confirmDialog({
    title: "Remove upload-pool node?",
    message: `Sends will stop using "${name}".`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
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

function wireTxSenderBulk() {
  const form = document.getElementById("txsender-bulk-form");
  const err = document.getElementById("txsender-bulk-error");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const raw = (new FormData(form).get("urls") || "").toString();
    const urls = raw.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
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

// ── stoachain routing rule-book (static, code-derived) ────────────────────────
// The real read/send/failover rules, extracted from dial/nodePool/hub/send/store
// and verified against the code 2026-07-16. Kept as data so the panel is a plain
// render — it changes only when the routing code changes.
const STOACHAIN_RULES = [
  {
    title: "Read rotation (feed live)",
    body: "When the AncientHub feed is live, each read rotates across the hub fleet as the primary leg, with an Upload Pool node held as the fallback leg for that request.",
  },
  {
    title: "Feed down",
    body: "When the feed is off, erroring, or reports zero slots, both the primary and fallback legs rotate across the Upload Pool instead.",
  },
  {
    title: "Both pools empty",
    body: "If the Upload Pool is also empty, the read fails closed with 503 pythia_no_read_node — there is no silent fallback to nothing.",
  },
  {
    title: "Failover is transport-only",
    body: "A node's HTTP error response (4xx/5xx) is returned to the caller verbatim — it is never treated as a failover trigger. Only transport failures (timeouts, connection errors) fail over, with one retry and a 10s per-attempt timeout; if both legs exhaust their attempts, the read returns 502 pythia_pool_exhausted.",
  },
  {
    title: "Last-good slots",
    body: "If a hub-feed poll fails, Pythia keeps serving the last-good slot list rather than dropping to zero — it only changes once the feed recovers or an admin reconfigures the hub.",
  },
  {
    title: "Sends",
    body: "Signed-tx sends go only to the Upload Pool, tried in the order nodes were added — never to hub read nodes. An empty or fully-disabled pool fails closed with 503 pythia_no_tx_sender.",
  },
  {
    title: "Seed permanence",
    body: "The two seed nodes, node1.stoachain.com and node2.stoachain.com, are permanent — they can't be disabled or removed — and they serve reads whenever the hub feed is off.",
  },
  {
    title: "Cadences",
    body: "The hub feed is re-polled every 60s and seed-pair health every 15s. There is no node blacklist or circuit breaker — every request fails over live, node by node.",
  },
];

function renderStoachainRules() {
  const container = document.getElementById("stoachain-rules");
  if (!container) return;
  container.textContent = "";

  const heading = document.createElement("h3");
  heading.textContent = "How StoaChain routing works — verified against the code 2026-07-16";
  container.appendChild(heading);

  for (const rule of STOACHAIN_RULES) {
    const title = document.createElement("p");
    title.className = "hub-stat";
    const b = document.createElement("b");
    b.textContent = rule.title;
    title.appendChild(b);

    const body = document.createElement("p");
    body.className = "panel-note";
    body.textContent = rule.body;

    container.append(title, body);
  }
}

// ── version & network (live /healthz readout) ──────────────────────────────────
async function loadVersionNetwork() {
  const container = document.getElementById("version-network");
  if (!container) return;
  try {
    const res = await fetch("/admin/version-info", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`version-info ${res.status}`);
    renderVersionNetwork(container, await res.json());
  } catch {
    container.textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Could not read version info.";
    container.appendChild(p);
  }
}

// Installed → available, Mnemosyne-style: grouped, FRAMED rows — the entity (Pythia)
// in its own group, then the automaton organs (Codex, Khronoton) under "Constructors".
// Each row shows the name + package on the left and version chips on the right
// (installed → available when newer, "up to date" when equal, "latest: unreachable").
function verBadge(text, kind) {
  const s = document.createElement("span");
  s.className = `ver-chip ver-chip--${kind}`;
  s.textContent = text;
  return s;
}

function verRow(label, sub, installed, available, updateAvailable) {
  const row = document.createElement("li");
  row.className = "deploy-row";

  const name = document.createElement("span");
  name.className = "deploy-row-name";
  name.textContent = label;
  if (sub) {
    const em = document.createElement("em");
    em.className = "deploy-row-sub";
    em.textContent = ` · ${sub}`;
    name.appendChild(em);
  }

  const badges = document.createElement("span");
  badges.className = "deploy-row-badges";
  badges.appendChild(verBadge(`v${installed || "unknown"}`, "installed"));
  if (available && updateAvailable) {
    const arrow = document.createElement("span");
    arrow.className = "ver-arrow";
    arrow.textContent = "→";
    badges.append(arrow, verBadge(`v${available}`, "update"));
  } else if (available) {
    const ok = document.createElement("span");
    ok.className = "deploy-uptodate";
    ok.textContent = "up to date";
    badges.appendChild(ok);
  } else {
    const unk = document.createElement("span");
    unk.className = "deploy-uptodate deploy-uptodate--unreachable";
    unk.textContent = "latest: unreachable";
    badges.appendChild(unk);
  }

  row.append(name, badges);
  return row;
}

function verGroup(title, rows) {
  const group = document.createElement("div");
  group.className = "deploy-group";
  const h = document.createElement("h4");
  h.className = "deploy-group-title";
  h.textContent = title;
  const ul = document.createElement("ul");
  ul.className = "deploy-rows";
  for (const r of rows) ul.appendChild(r);
  group.append(h, ul);
  return group;
}

function renderVersionNetwork(container, info) {
  container.textContent = "";
  container.appendChild(
    verGroup("Pythia", [
      verRow("Pythia", "the read gateway", info.installed, info.available, info.updateAvailable),
    ]),
  );
  const organRows = (info.organs || []).map((o) =>
    verRow(o.label, o.pkg, o.installed, o.available, o.updateAvailable),
  );
  if (organRows.length) container.appendChild(verGroup("Constructors", organRows));
}

// ── on-box deploy (status readout + Deploy button + SSE build-log terminal) ───
// The EventSource of the in-flight deploy, or null. Non-null keeps the Deploy
// button disabled even across loadDeployStatus() re-renders of the readout.
let deployStream = null;

async function loadDeployStatus() {
  const container = document.getElementById("deploy-status");
  const btn = document.getElementById("deploy-btn");
  if (!container) return;
  try {
    const res = await fetch("/api/admin/deploy/status", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`deploy status ${res.status}`);
    const body = await res.json();
    renderDeployStatus(container, body);
    if (btn) btn.disabled = body.mode === "dev" || deployStream !== null;
  } catch {
    container.textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Could not read the deploy status — sign in again or check the gateway.";
    container.appendChild(p);
    if (btn) btn.disabled = true;
  }
}

function renderDeployStatus(container, s) {
  container.textContent = "";
  const line = (label, value) => {
    const p = document.createElement("p");
    p.className = "hub-stat";
    const b = document.createElement("b");
    b.textContent = `${label}: `;
    const v = document.createElement("span");
    v.textContent = value;
    p.append(b, v);
    return p;
  };
  if (s.mode === "dev") {
    const note = document.createElement("p");
    note.className = "panel-note";
    note.textContent = "dev mode — on-box deploy is available on the live server only";
    container.append(note, line("Version", s.version || "unknown"));
    return;
  }
  container.append(
    line("Mode", s.mode || "unknown"),
    line("Live color", s.color || "unknown"),
    line("Loopback port", s.port ? `127.0.0.1:${s.port}` : "unknown"),
    line("Container", s.container || "unknown"),
    line("Version", s.version || "unknown"),
  );
}

function wireDeployButton() {
  const btn = document.getElementById("deploy-btn");
  const confirmBox = document.getElementById("deploy-confirm");
  const yes = document.getElementById("deploy-confirm-yes");
  const no = document.getElementById("deploy-confirm-no");
  const err = document.getElementById("deploy-error");
  if (!btn) return;

  // Inline confirm (no popup): clicking Deploy reveals the Yes/Cancel card just BELOW
  // the button (the button stays put); Cancel hides it again; Yes fires the deploy.
  const showConfirm = (on) => {
    if (confirmBox) confirmBox.hidden = !on;
  };

  const runDeploy = async () => {
    if (err) err.hidden = true;
    btn.disabled = true; // stays disabled while the deploy streams; done re-enables
    try {
      const res = await fetch("/api/admin/deploy", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.id) {
        if (err) { err.textContent = body.error || `Deploy request failed (${res.status}).`; err.hidden = false; }
        btn.disabled = false;
        return;
      }
      openDeployStream(body.id);
    } catch {
      if (err) { err.textContent = "Network error requesting the deploy."; err.hidden = false; }
      btn.disabled = false;
    }
  };

  btn.addEventListener("click", () => {
    if (err) err.hidden = true;
    showConfirm(true);
  });
  if (no) no.addEventListener("click", () => showConfirm(false));
  if (yes) yes.addEventListener("click", () => {
    showConfirm(false);
    void runDeploy();
  });
}

function openDeployStream(id) {
  const log = document.getElementById("deploy-log");
  const statusLine = document.getElementById("deploy-stream-status");
  const btn = document.getElementById("deploy-btn");
  if (!log) return;
  if (deployStream) deployStream.close();
  log.hidden = false;
  log.textContent = "";
  const append = (text) => {
    log.textContent += text;
    log.scrollTop = log.scrollHeight; // keep the tail in view
  };

  const es = new EventSource("/api/admin/deploy/stream/" + encodeURIComponent(id));
  deployStream = es;

  es.onopen = () => {
    // Clear the buffer on every (re)connect: mid-deploy the color swap kills
    // this container — EventSource auto-reconnects to the NEW one, whose tail
    // replays the whole log from byte 0. Clearing first means the replay lands
    // once, instead of being appended after a partial copy.
    log.textContent = "";
  };

  // The chunk already carries its own newlines (a byte slice of the log); do NOT
  // add one, or every ~500ms poll batch gets a spurious blank line / split line.
  es.onmessage = (e) => { append(e.data); };

  es.addEventListener("status", (e) => {
    if (statusLine) {
      statusLine.hidden = false;
      statusLine.textContent = `Deploy status: ${e.data}`;
    }
  });

  es.addEventListener("done", (e) => {
    append(`— deploy ${e.data}\n`);
    es.close();
    deployStream = null;
    if (btn) btn.disabled = false;
    loadDeployStatus(); // the color/port flipped — refresh the readout
  });
}

// ── StoaChain Earnings (the Pyth ledger) ─────────────────────────────────────
function renderEarningsTotals(el, t) {
  if (!el) return;
  el.textContent = "";
  const int = (x) => (Number(x) || 0).toLocaleString("en-US");
  const dec = (x) => (Number(x) || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const card = (label, value) => {
    const d = document.createElement("div");
    d.className = "earn-card";
    const v = document.createElement("span");
    v.className = "earn-value";
    v.textContent = value;
    const l = document.createElement("span");
    l.className = "earn-label";
    l.textContent = label;
    d.append(v, l);
    return d;
  };
  el.append(
    card("petitions", int(t.petitions)),
    card("pondus", dec(t.pondus)),
    card("transactions", int(t.transactions)),
    card("gas reserved", int(t.gasReserved)),
    card("failed tx", int(t.failedTransactions)),
    card("wasted gas", int(t.wastedGasReserved)),
  );
}

async function loadEarnings() {
  const totals = document.getElementById("earnings-totals");
  const toggle = document.getElementById("earn-report-toggle");
  const label = document.getElementById("earn-report-label");
  try {
    const res = await fetch("/admin/pyth", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const data = await res.json();
    renderEarningsTotals(totals, data.total || {});
    if (toggle) toggle.checked = !!data.reportToHub;
    if (label) {
      label.textContent = data.reportToHub
        ? "Reporting ON — served usage flows to the hub (mints)"
        : "Reporting OFF — counting locally only (no minting)";
    }
  } catch {
    /* leave as-is */
  }
}

// ── Pyth Flush (the live per-day backlog the next A_Flush would send) ─────────
function renderEpochLine(el, epoch) {
  if (!el || !epoch) return;
  const src = epoch.source;
  const label =
    src === "chain"
      ? `read from chain${epoch.readAt ? ` · cached ${new Date(epoch.readAt).toLocaleString()}` : ""}`
      : src === "cached"
        ? `cached from a prior chain read${epoch.readAt ? ` · ${new Date(epoch.readAt).toLocaleString()}` : ""}`
        : "hardcoded default — chain not read yet";
  el.innerHTML = `Day 1: <b>${epoch.iso}</b> <span class="earn-epoch-src earn-epoch-src--${src}">${label}</span>`;
}

// The UTC date (YYYY-MM-DD) for a day ordinal, given the epoch ms.
function dayDate(ordinal, epochMs) {
  return new Date(epochMs + (ordinal - 1) * 86400000).toISOString().slice(0, 10);
}

function renderFlushTable(el, entries, epochMs) {
  if (!el) return;
  el.textContent = "";
  if (!entries || entries.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No unflushed data yet — the ledger is empty for the current window.";
    el.appendChild(p);
    return;
  }
  const cols = ["Day", "Date (UTC)", "Status", "Petitions", "Pondus", "Transactions", "Gas reserved", "Failed", "Wasted gas"];
  const keys = ["petitions", "pondus", "transactions", "gas-reserved", "failed-transactions", "wasted-gas-reserved"];
  const table = document.createElement("table");
  table.className = "flush-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const e of entries) {
    const tr = document.createElement("tr");
    const cells = [String(e.day), dayDate(e.day, epochMs)];
    const dayCell = document.createElement("td");
    dayCell.textContent = cells[0];
    const dateCell = document.createElement("td");
    dateCell.textContent = cells[1];
    const statusCell = document.createElement("td");
    const complete = !!e["iz-complete"];
    statusCell.innerHTML = `<span class="flush-status flush-status--${complete ? "sealed" : "open"}">${complete ? "complete → seals" : "open (today)"}</span>`;
    tr.append(dayCell, dateCell, statusCell);
    for (const k of keys) {
      const td = document.createElement("td");
      td.className = "flush-num";
      td.textContent = String(e[k] ?? 0);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  el.appendChild(table);
}

async function refreshPythFlush() {
  try {
    const res = await fetch("/admin/pyth", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const data = await res.json();
    renderEpochLine(document.getElementById("flush-epoch"), data.epoch);
    const warn = document.getElementById("flush-warn");
    if (warn) {
      const n = Number(data.unflushedDays) || 0;
      if (n > 2) {
        warn.textContent = `⚠ ${n} days of ledger data are unflushed — the daily on-chain A_Flush looks stuck. Check the Khronoton flush cronoton.`;
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    }
    const epochMs = data.epoch ? Number(data.epoch.epochMs) : Date.UTC(2026, 6, 21);
    renderFlushTable(document.getElementById("flush-table"), data.flushEntries || [], epochMs);
  } catch {
    /* leave as-is */
  }
}

// Live monitor: refresh on open, then poll every 10s while the panel stays visible;
// self-cancels once you navigate away (the view becomes hidden).
let pythFlushTimer = null;
async function loadPythFlush() {
  await refreshPythFlush();
  if (pythFlushTimer) clearInterval(pythFlushTimer);
  pythFlushTimer = setInterval(() => {
    const view = document.querySelector('[data-view="pyth-flush"]');
    if (!view || view.hidden) {
      clearInterval(pythFlushTimer);
      pythFlushTimer = null;
      return;
    }
    void refreshPythFlush();
  }, 10000);
}

function wireEarnings() {
  const nukeBtn = document.getElementById("earn-nuke-btn");
  const nukeErr = document.getElementById("earn-nuke-error");
  if (nukeBtn) {
    nukeBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Nuke the Pyth ledger?",
        message:
          "This resets every counter — Petitions, Pondus, transactions, gas — to zero. It erases the local counts and cannot be undone.",
        confirmLabel: "Nuke it",
        danger: true,
      });
      if (!ok) return;
      if (nukeErr) nukeErr.hidden = true;
      try {
        const res = await fetch("/admin/pyth/nuke", { method: "POST", headers: { accept: "application/json" } });
        if (!res.ok) {
          if (nukeErr) { nukeErr.textContent = "Nuke failed — is your ancient session still valid?"; nukeErr.hidden = false; }
          return;
        }
        loadEarnings();
      } catch {
        if (nukeErr) { nukeErr.textContent = "Network error."; nukeErr.hidden = false; }
      }
    });
  }

  const toggle = document.getElementById("earn-report-toggle");
  const toggleErr = document.getElementById("earn-report-error");
  if (toggle) {
    toggle.addEventListener("change", async () => {
      if (toggleErr) toggleErr.hidden = true;
      try {
        const res = await fetch("/admin/pyth/report", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ enabled: toggle.checked }),
        });
        if (!res.ok) throw new Error("failed");
        loadEarnings();
      } catch {
        toggle.checked = !toggle.checked; // revert the optimistic flip
        if (toggleErr) { toggleErr.textContent = "Could not update the setting."; toggleErr.hidden = false; }
      }
    });
  }
}

// ── Security (sealed vault) ──────────────────────────────────────────────────
// The three vault states → badge text/class + an explanatory line. `plaintextFallback`
// (no master key) wins over the raw mode for the human-facing label.
function securityView(st) {
  if (st.plaintextFallback) {
    return {
      cls: "sec-badge--warn",
      text: "Plaintext fallback",
      explain:
        "No PYTHIA_MASTER_KEY is set, so bearer credentials are stored unencrypted on the data volume (dev only). Set a master key in the deploy env to seal them at rest.",
    };
  }
  if (st.mode === "locked") {
    return {
      cls: "sec-badge--warn",
      text: "Locked — key mismatch",
      explain:
        "A master key is set but a sealed credential will not decrypt under it (the key changed). The hub feed falls back to the env secret / off until the correct key is restored or the vault is re-sealed.",
    };
  }
  return {
    cls: "sec-badge--sealed",
    text: "Sealed ✓",
    explain: "Bearer credentials are encrypted at rest (AES-256-GCM) under the deploy master key.",
  };
}

function renderSecurity(st) {
  const badge = document.getElementById("sec-badge");
  const fp = document.getElementById("sec-fingerprint");
  const explain = document.getElementById("sec-explain");
  const creds = document.getElementById("sec-creds");
  const clearBtn = document.getElementById("sec-clear-btn");
  const view = securityView(st);

  if (badge) {
    badge.textContent = view.text;
    badge.className = "sec-badge " + view.cls;
  }
  if (fp) {
    fp.textContent = st.fingerprint ? `master key #${st.fingerprint}` : "no master key";
  }
  if (explain) explain.textContent = view.explain;

  if (creds) {
    creds.textContent = "";
    const names = Array.isArray(st.names) ? st.names : [];
    if (!names.length) {
      const empty = document.createElement("p");
      empty.className = "panel-note";
      empty.textContent = "No sealed credentials.";
      creds.appendChild(empty);
    } else {
      for (const name of names) {
        const row = document.createElement("div");
        row.className = "sec-cred";
        const n = document.createElement("span");
        n.className = "sec-cred-name";
        n.textContent = name;
        const mask = document.createElement("span");
        mask.className = "sec-cred-mask";
        mask.textContent = "•••••••• sealed";
        row.append(n, mask);
        creds.appendChild(row);
      }
    }
  }

  if (clearBtn) clearBtn.disabled = (st.sealedCount || 0) === 0;
}

async function loadSecurity() {
  try {
    const res = await fetch("/admin/security", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    renderSecurity(await res.json());
  } catch {
    /* leave as-is */
  }
}

function wireSecurity() {
  const clearBtn = document.getElementById("sec-clear-btn");
  const err = document.getElementById("sec-clear-error");
  if (!clearBtn) return;
  clearBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Clear the sealed vault?",
      message:
        "This deletes every sealed credential — including the hub HMAC secret. The hub feed will have no secret until one is re-set. Cannot be undone.",
      confirmLabel: "Clear vault",
      danger: true,
    });
    if (!ok) return;
    if (err) err.hidden = true;
    try {
      const res = await fetch("/admin/security/clear", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        if (err) { err.textContent = "Clear failed — is your ancient session still valid?"; err.hidden = false; }
        return;
      }
      renderSecurity(await res.json());
    } catch {
      if (err) { err.textContent = "Network error."; err.hidden = false; }
    }
  });
}

// ── Codex island (the React codex-ui, lazy-loaded on first open) ──────────────
// The 1.9MB bundle only loads when the Codex section is first opened. It mounts
// itself into #codex-island (replacing the loading note) — see codex-ui/index.tsx.
let codexIslandLoaded = false;
function loadCodexIsland() {
  if (codexIslandLoaded) return;
  codexIslandLoaded = true;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/codex-island.css";
  document.head.appendChild(css);
  const js = document.createElement("script");
  js.type = "module";
  js.src = "/codex-island.js";
  js.onerror = () => {
    const el = document.getElementById("codex-loading");
    if (el) el.textContent = "Could not load the Codex bundle — run `npm run build:island`.";
  };
  document.body.appendChild(js);
}

// ── Khronoton island (the React khronoton-ui, lazy-loaded on first open) ──────
// The bundle only loads when the Khronoton section is first opened. It mounts into
// #khronoton-island (replacing the loading note) — see khronoton-ui/index.tsx.
let khronotonIslandLoaded = false;
function loadKhronotonIsland() {
  if (khronotonIslandLoaded) return;
  khronotonIslandLoaded = true;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/khronoton-island.css";
  document.head.appendChild(css);
  const js = document.createElement("script");
  js.type = "module";
  js.src = "/khronoton-island.js";
  js.onerror = () => {
    const el = document.getElementById("khronoton-loading");
    if (el) el.textContent = "Could not load the Khronoton bundle — run `npm run build:island`.";
  };
  document.body.appendChild(js);
}

// ── init ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".admin-back").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.back;
    if (target) {
      location.hash = target; // one level up (e.g. stoachain → #connectors)
    } else {
      goToLanding();
    }
  });
});
window.addEventListener("hashchange", routeFromHash);
wireChainSubtabs();
wireVerifierForm();
wireHubConfig();
wireTxSenderForm();
wireTxSenderBulk();
wireDeployButton();
wireEarnings();
wireSecurity();
loadVersion(); // fill the brand's version chip from /healthz
applyGate(); // render the "checking…" state before /api/me resolves
loadMe();

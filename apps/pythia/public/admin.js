// Pythia Admin dashboard — the dedicated ancient-gated surface at /admin. Houses
// the gated functions that used to be the landing's "Hub feed" tab (Observation
// Pool + Upload Pool) plus the new Verifier registry. The page gates ITSELF on
// GET /api/me (the mutations all hit ancient-gated /admin/* APIs), so serving the
// shell to anyone is safe.

import { renderIdentity, setVersion } from "./pantheon-header.js";

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
    id: "security",
    icon: "🔑",
    title: "Security",
    blurb: "Master-key sealed-creds vault + rotation.",
    hash: "#security",
    enabled: false,
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
    loadTxSenders();
    renderStoachainRules();
  },
  "update-deploy": () => {
    loadVersionNetwork();
    loadDeployStatus();
  },
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
  if (!window.confirm(`Remove verifier "${name}"? The Verify popup will stop offering it.`)) return;
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
    const res = await fetch("/healthz", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`healthz ${res.status}`);
    const body = await res.json();
    renderVersionNetwork(container, body);
  } catch {
    container.textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Could not read /healthz — version and source reachability are unavailable.";
    container.appendChild(p);
  }
}

function renderVersionNetwork(container, body) {
  container.textContent = "";

  const versionLine = document.createElement("p");
  versionLine.className = "hub-stat";
  const b = document.createElement("b");
  b.textContent = "Version: ";
  const v = document.createElement("span");
  v.textContent = body.version || "unknown";
  versionLine.append(b, v);
  container.appendChild(versionLine);

  const sources = Array.isArray(body.sources) ? body.sources : [];
  if (!sources.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No sources reported.";
    container.appendChild(empty);
    return;
  }

  for (const s of sources) {
    const row = document.createElement("div");
    row.className = "txrow";

    const main = document.createElement("span");
    main.className = "txrow-main";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("data-color", s.reachable ? "green" : "red");
    main.appendChild(dot);
    const label = document.createElement("b");
    label.className = "txrow-label";
    label.textContent = s.id || "source";
    main.appendChild(label);
    if (s.role) {
      const badge = document.createElement("span");
      badge.className = "ca-badge";
      badge.textContent = s.role;
      main.appendChild(badge);
    }
    const url = document.createElement("span");
    url.className = "txrow-url";
    url.textContent = s.url || "";
    main.appendChild(url);

    row.appendChild(main);
    container.appendChild(row);
  }
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
  const err = document.getElementById("deploy-error");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!window.confirm("Rebuild Pythia from origin/main on the box and swap colors with zero downtime?")) return;
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
loadVersion(); // fill the brand's version chip from /healthz
applyGate(); // render the "checking…" state before /api/me resolves
loadMe();

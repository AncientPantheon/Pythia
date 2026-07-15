// Pythia Admin dashboard — the dedicated ancient-gated surface at /admin. Houses
// the gated functions that used to be the landing's "Hub feed" tab (Observation
// Pool + Upload Pool) plus the new Verifier registry. The page gates ITSELF on
// GET /api/me (the mutations all hit ancient-gated /admin/* APIs), so serving the
// shell to anyone is safe.

// ── auth / session ───────────────────────────────────────────────────────────
// `null` until GET /api/me resolves (the gate's "checking…" state); an object
// afterwards.
let authState = null;

function isAncient() {
  return !!(authState && authState.authenticated && authState.roles.includes("ancient"));
}

function renderAuthbox() {
  const box = document.getElementById("authbox");
  if (!box) return;
  box.textContent = "";
  if (authState && authState.authenticated) {
    const who = document.createElement("span");
    who.className = "who";
    const nm = document.createElement("b");
    nm.textContent = authState.name || "user";
    who.append("Signed in as ", nm);
    if (authState.roles.length) {
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = authState.roles[0];
      who.append(" · ", role);
    }
    const out = document.createElement("a");
    out.className = "btn btn--ghost btn--small";
    out.href = "/admin/logout";
    out.textContent = "Log out";
    box.append(who, out);
  } else {
    const login = document.createElement("a");
    login.className = "btn btn--small";
    login.href = "/admin/login";
    login.textContent = "Log in";
    box.appendChild(login);
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

// ── admin gate + tile landing + hash router ──────────────────────────────────
// The shared gate owns four states, driven purely by `authState`:
//   • authState === null           → "checking…" (before /api/me resolves)
//   • not authenticated            → a login prompt
//   • authenticated, not ancient   → a "requires the ancient role" notice
//   • ancient                      → the tile landing (+ hash-routed views)
// This is UX only — every /admin/* mutation is gated again server-side.
function applyGate() {
  const body = document.getElementById("admin-body");
  const gate = document.getElementById("admin-gate");

  if (isAncient()) {
    if (gate) { gate.hidden = true; gate.textContent = ""; }
    if (body) body.hidden = false;
    renderTiles();
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

// The function tiles rendered on the landing. Enabled tiles hash-route into their
// view; disabled ("planned") tiles render a badge and are inert (T2 turns some of
// these — plus a Version & Network tile — into live views).
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
    id: "observation",
    icon: "🛰️",
    title: "Observation Pool",
    blurb: "The AncientHub-fed read fleet — activate the feed and fan reads out.",
    hash: "#observation",
    enabled: true,
  },
  {
    id: "upload",
    icon: "📤",
    title: "Upload Pool",
    blurb: "Signed-tx senders that carry every send (and reads when the feed is off).",
    hash: "#upload",
    enabled: true,
  },
  {
    id: "version",
    icon: "📟",
    title: "Version & Network",
    blurb: "Live PYTHIA_VERSION and per-source reachability, read from /healthz.",
    hash: "#version",
    enabled: true,
  },
  {
    id: "update-deploy",
    icon: "⬆️",
    title: "Update & Deploy",
    blurb: "On-box pull + blue-green deploy of the gateway.",
    hash: "#update-deploy",
    enabled: false,
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

// Views the hash router knows how to open (map back to their load* function).
const VIEW_LOADERS = {
  verifiers: loadVerifiers,
  observation: loadHubStatus,
  upload: loadTxSenders,
  version: loadVersionNetwork,
};

function renderTiles() {
  const grid = document.getElementById("admin-tiles");
  if (!grid) return;
  grid.textContent = "";
  for (const t of TILES) {
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
      badge.textContent = "planned";
      bodyEl.appendChild(badge);
    }

    tile.append(icon, bodyEl);
    grid.appendChild(tile);
  }
}

// A disabled tile just posts a short note — never a view, never a backend call.
function showPlannedNote(title) {
  const note = document.getElementById("admin-tile-note");
  if (!note) return;
  note.textContent = `${title} is coming in a later round.`;
  note.hidden = false;
}

// Hash router: no (known) hash → the landing; #verifiers/#observation/#upload →
// that view (landing hidden), firing its load* function so data shows on open.
function routeFromHash() {
  if (!isAncient()) return;
  const name = location.hash.replace(/^#/, "");
  const known = Object.prototype.hasOwnProperty.call(VIEW_LOADERS, name);
  const tiles = document.getElementById("admin-tiles");
  const note = document.getElementById("admin-tile-note");
  const views = document.querySelectorAll(".admin-view");

  if (known) {
    if (tiles) tiles.hidden = true;
    if (note) note.hidden = true;
    views.forEach((v) => { v.hidden = v.dataset.view !== name; });
    VIEW_LOADERS[name]();
  } else {
    if (tiles) tiles.hidden = false;
    views.forEach((v) => { v.hidden = true; });
  }
}

// The "← Dashboard" back control clears the hash (which fires the router).
function goToLanding() {
  if (location.hash) {
    location.hash = "";
  } else {
    routeFromHash();
  }
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

// ── init ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".admin-back").forEach((btn) => {
  btn.addEventListener("click", goToLanding);
});
window.addEventListener("hashchange", routeFromHash);
wireVerifierForm();
wireHubConfig();
wireTxSenderForm();
wireTxSenderBulk();
applyGate(); // render the "checking…" state before /api/me resolves
loadMe();

// Pythia landing client — vanilla, framework-free, no bundler. The page is
// MODULAR per chain: `CHAINS` drives a chain selector, and each chain renders
// its own self-contained module (node pool + dirty-read console + endpoints).
// Adding a chain = adding one entry to CHAINS.

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

// ── hero live pill (service-wide, independent of chain selection) ────────────
function updateLivePill(snapshot) {
  const pill = document.getElementById("livepill");
  const text = document.getElementById("livetext");
  if (!pill || !text) return;
  const total = snapshot.sources ? snapshot.sources.length : 0;
  const up = snapshot.sources ? snapshot.sources.filter((s) => s.reachable).length : 0;

  let mod = "livepill--down";
  let msg = "nodes unreachable";
  if (snapshot.routing === "primary") {
    mod = "livepill--ok";
    msg = `live · ${up}/${total} nodes reachable`;
  } else if (snapshot.routing === "fallback") {
    mod = "livepill--degr";
    msg = `degraded · on fallback (${up}/${total})`;
  }
  pill.className = `livepill ${mod}`;
  text.textContent = msg;

  // Surface the running service version in the footer so a deploy is verifiable
  // at a glance. /healthz carries it; render it once it's known.
  const ver = document.getElementById("version");
  if (ver && snapshot.version) ver.textContent = `v${snapshot.version}`;
}

function pillError() {
  const pill = document.getElementById("livepill");
  const text = document.getElementById("livetext");
  if (!pill || !text) return;
  pill.className = "livepill livepill--down";
  text.textContent = "status unavailable";
}

// ── connectors ──────────────────────────────────────────────────────────────
function renderConnectors(container, connectors) {
  container.textContent = "";
  if (!connectors || connectors.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No connectors listed yet.";
    container.appendChild(empty);
    return;
  }
  for (const connector of connectors) {
    const link = document.createElement("a");
    link.className = "connector";
    link.href = connector.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (connector.logo !== undefined) {
      const img = document.createElement("img");
      img.className = "connector-logo";
      img.src = connector.logo;
      img.alt = `${connector.name} logo`;
      link.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = connector.name;
    link.appendChild(label);
    container.appendChild(link);
  }
}

// Admin view of connectors: name, url, key prefix, public badge, revoke.
function renderAdminConnectors(container, connectors) {
  container.textContent = "";
  if (!connectors || connectors.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No connectors yet. Add one above.";
    container.appendChild(empty);
    return;
  }
  for (const conn of connectors) {
    const card = document.createElement("div");
    card.className = "connector-admin";

    const head = document.createElement("div");
    head.className = "ca-head";
    const nm = document.createElement("b");
    nm.textContent = conn.name;
    head.appendChild(nm);
    if (conn.isPublic) {
      const badge = document.createElement("span");
      badge.className = "ca-badge";
      badge.textContent = "public";
      head.appendChild(badge);
    }

    const url = document.createElement("a");
    url.className = "ca-url";
    url.href = conn.url;
    url.target = "_blank";
    url.rel = "noopener noreferrer";
    url.textContent = conn.url;

    const key = document.createElement("code");
    key.className = "ca-key";
    key.textContent = `${conn.keyPrefix}…`;

    const revoke = document.createElement("button");
    revoke.className = "btn btn--ghost btn--small ca-revoke";
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => revokeConnector(conn.id, conn.name));

    card.append(head, url, key, revoke);
    container.appendChild(card);
  }
}

async function revokeConnector(id, name) {
  if (!window.confirm(`Revoke connector "${name}"? Its API key stops working immediately.`)) return;
  try {
    const res = await fetch(`/admin/connectors/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (res.ok) loadConnectorsView();
  } catch {
    /* ignore — the list simply won't change */
  }
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

    <div class="chain-grid">
      <div class="sub">
        <div class="sub-head"><h4>Node pool</h4><span class="sub-note"><code>/healthz</code> · 15s</span></div>
        <div class="sources" data-role="sources" aria-live="polite">
          <div class="source-row"><span class="dot" data-color="grey"></span><span class="source-label">checking…</span></div>
        </div>
        <p class="legend">
          <span class="key"><span class="dot" data-color="green"></span> primary</span>
          <span class="key"><span class="dot" data-color="amber"></span> fallback</span>
          <span class="key"><span class="dot" data-color="red"></span> down</span>
        </p>
      </div>

      <div class="sub">
        <div class="sub-head"><h4>Endpoints</h4></div>
        <ul class="endpoints endpoints--compact">
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/read</code></li>
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/send</code></li>
          <li><span class="verb verb--post">POST</span> <code>${chain.base}/poll</code></li>
        </ul>
      </div>
    </div>

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
    </div>`;

  // set the placeholder via property so the example's quotes/newlines are literal
  const code = mod.querySelector('[data-role="code"]');
  if (code) code.placeholder = chain.readExample || "";

  // this chain's node-pool health poll
  const sources = mod.querySelector('[data-role="sources"]');
  stopChainHealth = createRefreshLoop({
    fetchSnapshot: () => fetch(chain.health, { headers: { accept: "application/json" } }).then((r) => r.json()),
    onSnapshot: (snap) => {
      if (sources) renderSources(sources, snap.sources, snap.routing);
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
  const box = document.getElementById("authbox");
  if (!box) return;
  box.textContent = "";
  if (authState.authenticated) {
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
  updateAddConnectorControl();
  updateHubFeedTab();
  loadConnectorsView();
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
    if (!res.ok) return;
    const body = await res.json();
    renderTxSenders(container, body.senders ?? []);
  } catch {
    /* ignore */
  }
}

function renderTxSenders(container, senders) {
  container.textContent = "";
  if (!senders.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No upload-pool nodes — sends are disabled (503) until you add one.";
    container.appendChild(empty);
    return;
  }
  for (const s of senders) {
    const card = document.createElement("div");
    card.className = "connector-admin" + (s.enabled ? "" : " txsender--off");

    const head = document.createElement("div");
    head.className = "ca-head";
    const nm = document.createElement("b");
    nm.textContent = s.label || s.url;
    head.appendChild(nm);
    if (s.seed) {
      const badge = document.createElement("span");
      badge.className = "ca-badge ca-badge--seed";
      badge.textContent = "seed node";
      head.appendChild(badge);
    }
    if (!s.enabled) {
      const badge = document.createElement("span");
      badge.className = "ca-badge";
      badge.textContent = "disabled";
      head.appendChild(badge);
    }

    const url = document.createElement("span");
    url.className = "ca-url";
    url.textContent = s.url;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn btn--ghost btn--small";
    toggle.textContent = s.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", () => setTxSenderEnabled(s.id, !s.enabled));

    const actions = document.createElement("span");
    actions.className = "txsender-actions";
    actions.append(toggle);
    // Seed nodes are permanent — no Remove button.
    if (!s.seed) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--ghost btn--small";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeTxSender(s.id, s.label || s.url));
      actions.append(remove);
    }

    card.append(head, url, actions);
    container.appendChild(card);
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

// ── connectors loader (public list, or admin list for ancient) ───────────────
async function loadConnectorsView() {
  const container = document.getElementById("connectors");
  if (!container) return;
  if (isAncient()) {
    try {
      const res = await fetch("/admin/connectors", { headers: { accept: "application/json" } });
      if (res.ok) {
        const body = await res.json();
        renderAdminConnectors(container, body.connectors ?? []);
        return;
      }
    } catch {
      /* fall through to the public view */
    }
  }
  try {
    const res = await fetch("/api/v1/connectors", { headers: { accept: "application/json" } });
    const body = await res.json();
    renderConnectors(container, body.connectors ?? []);
  } catch {
    /* leave the empty-state message */
  }
}

function updateAddConnectorControl() {
  const btn = document.getElementById("add-connector-btn");
  const hint = document.getElementById("add-connector-hint");
  if (!btn) return;
  const allowed = isAncient();
  btn.disabled = !allowed;
  if (hint) {
    hint.textContent = allowed
      ? ""
      : authState.authenticated
        ? "Your role can't add connectors — the ancient role is required."
        : "Sign in as an ancient admin to add connectors.";
  }
}

function showNewKey(panel, connector, apiKey) {
  panel.textContent = "";
  panel.hidden = false;
  const head = document.createElement("p");
  head.className = "nk-head";
  head.textContent = `API key for ${connector.name} — copy it now, it will not be shown again:`;
  const row = document.createElement("div");
  row.className = "nk-key";
  const code = document.createElement("code");
  code.textContent = apiKey;
  const copy = document.createElement("button");
  copy.className = "btn btn--small";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(apiKey);
    copy.textContent = "Copied";
  });
  row.append(code, copy);
  const note = document.createElement("p");
  note.className = "nk-note";
  note.textContent = "The connector sends this as the x-pythia-key header on every request.";
  panel.append(head, row, note);
}

function wireAddConnector() {
  const btn = document.getElementById("add-connector-btn");
  const form = document.getElementById("add-connector-form");
  const cancel = document.getElementById("add-connector-cancel");
  const err = document.getElementById("add-connector-error");
  const keyPanel = document.getElementById("new-key-panel");
  if (!btn || !form || !keyPanel) return;

  btn.addEventListener("click", () => {
    form.hidden = false;
    keyPanel.hidden = true;
  });
  if (cancel) cancel.addEventListener("click", () => { form.hidden = true; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const data = new FormData(form);
    const payload = {
      name: (data.get("name") || "").toString().trim(),
      url: (data.get("url") || "").toString().trim(),
      logo: (data.get("logo") || "").toString().trim(),
      isPublic: data.get("isPublic") === "on",
    };
    try {
      const res = await fetch("/admin/connectors", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) {
          err.textContent = body.error || "Could not create the connector.";
          err.hidden = false;
        }
        return;
      }
      form.reset();
      form.hidden = true;
      showNewKey(keyPanel, body.connector, body.apiKey);
      loadConnectorsView();
    } catch {
      if (err) {
        err.textContent = "Network error creating the connector.";
        err.hidden = false;
      }
    }
  });
}

function startHealthPill() {
  createRefreshLoop({
    fetchSnapshot: fetchHealth,
    onSnapshot: updateLivePill,
    onError: pillError,
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
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("tab--active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tabpanel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  if (name === "activity") loadStats(); // refresh usage each time it's opened
}

function wireTabs() {
  document.querySelectorAll("[data-tab]").forEach((elm) => {
    elm.addEventListener("click", (e) => {
      if (elm.tagName === "A") e.preventDefault(); // hero CTAs are tab switchers
      showTab(elm.dataset.tab);
    });
  });
}

// ── init ─────────────────────────────────────────────────────────────────────
wireTabs();
wireAddConnector();
wireHubConfig();
wireTxSenderForm();
renderChainTabs();
startHealthPill();
loadMe(); // /api/me → renders the header + loads the right connectors view
loadStats();
showTab("chains");

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

// ── connectors loader + hero pill ───────────────────────────────────────────
async function loadConnectors() {
  const container = document.getElementById("connectors");
  if (!container) return;
  try {
    const res = await fetch("/api/v1/connectors", { headers: { accept: "application/json" } });
    const body = await res.json();
    renderConnectors(container, body.connectors ?? []);
  } catch {
    /* leave the empty-state message */
  }
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
renderChainTabs();
startHealthPill();
loadConnectors();
loadStats();
showTab("chains");

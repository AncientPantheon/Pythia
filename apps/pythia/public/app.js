// Pythia landing client — vanilla, framework-free, no bundler. Mirrors the
// unit-tested logic in src/landing/{indicator,render}.ts, expressed here against
// the real browser document/fetch/setInterval. Polls /healthz for live node
// health and loads the connector list from /api/v1/connectors.

const POLL_INTERVAL_MS = 15000;

// --- indicator: health -> colour ------------------------------------------
// unreachable -> red; reachable on fallback routing -> amber; otherwise green.
function sourceIndicator(source, routing) {
  if (!source.reachable) return "red";
  if (routing === "fallback") return "amber";
  return "green";
}

// --- render: node pool ----------------------------------------------------
function renderSources(container, sources, routing) {
  container.textContent = "";
  for (const source of sources) {
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

// --- render: hero live pill -----------------------------------------------
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
}

function pillError() {
  const pill = document.getElementById("livepill");
  const text = document.getElementById("livetext");
  if (!pill || !text) return;
  pill.className = "livepill livepill--down";
  text.textContent = "status unavailable";
}

// --- render: connectors ---------------------------------------------------
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

// --- refresh loop: fire immediately, then every intervalMs ----------------
function createRefreshLoop({ fetchSnapshot, onSnapshot, onError, intervalMs }) {
  const tick = () => {
    fetchSnapshot().then(onSnapshot).catch(onError || (() => {}));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// --- wiring ---------------------------------------------------------------
async function fetchHealth() {
  const res = await fetch("/healthz", { headers: { accept: "application/json" } });
  return res.json();
}

async function loadConnectors() {
  const container = document.getElementById("connectors");
  if (!container) return;
  try {
    const res = await fetch("/api/v1/connectors", { headers: { accept: "application/json" } });
    const body = await res.json();
    renderConnectors(container, body.connectors ?? []);
  } catch {
    /* leave the empty-state message; connectors are static and non-critical */
  }
}

function startHealth() {
  const container = document.getElementById("sources");
  createRefreshLoop({
    fetchSnapshot: fetchHealth,
    onSnapshot: (snapshot) => {
      if (container) renderSources(container, snapshot.sources, snapshot.routing);
      updateLivePill(snapshot);
    },
    onError: pillError,
    intervalMs: POLL_INTERVAL_MS,
  });
}

loadConnectors();
startHealth();

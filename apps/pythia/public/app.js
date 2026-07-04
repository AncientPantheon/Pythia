// Pythia landing client — vanilla, framework-free, no bundler. A faithful mirror
// of the unit-tested logic in src/landing/{indicator,render}.ts, expressed here
// against the real browser document/fetch/setInterval. The .ts modules are the
// normative contract (unit-tested in the node env); this file is the shipped
// browser asset served statically at /app.js.

const POLL_INTERVAL_MS = 15000;

// --- indicator.ts mirror: health -> color ---------------------------------
// unreachable -> red; reachable on fallback routing -> amber; reachable
// otherwise -> green. Grey is the pre-first-poll placeholder rendered in HTML.
function sourceIndicator(source, routing) {
  if (!source.reachable) return "red";
  if (routing === "fallback") return "amber";
  return "green";
}

// --- render.ts mirror: paint sources --------------------------------------
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
    label.textContent = source.id;
    row.appendChild(label);

    container.appendChild(row);
  }
}

// --- render.ts mirror: paint connectors -----------------------------------
function renderConnectors(container, connectors) {
  container.textContent = "";
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

// --- render.ts mirror: refresh loop ---------------------------------------
// Fire immediately, then every intervalMs. Returns a stop() that clears it.
function createRefreshLoop({ fetchSnapshot, onSnapshot, intervalMs }) {
  const tick = () => {
    fetchSnapshot()
      .then(onSnapshot)
      .catch(() => {
        /* transient fetch failure — the next tick retries */
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// --- wiring ----------------------------------------------------------------
async function fetchHealth() {
  const res = await fetch("/healthz", { headers: { accept: "application/json" } });
  return res.json();
}

async function loadConnectors() {
  const container = document.getElementById("connectors");
  try {
    const res = await fetch("/api/v1/connectors", {
      headers: { accept: "application/json" },
    });
    const body = await res.json();
    renderConnectors(container, body.connectors ?? []);
  } catch {
    // Leave the empty-state message; connectors are static and non-critical.
  }
}

function startHealth() {
  const container = document.getElementById("sources");
  createRefreshLoop({
    fetchSnapshot: fetchHealth,
    onSnapshot: (snapshot) =>
      renderSources(container, snapshot.sources, snapshot.routing),
    intervalMs: POLL_INTERVAL_MS,
  });
}

loadConnectors();
startHealth();

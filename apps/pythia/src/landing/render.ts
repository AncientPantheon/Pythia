import { sourceIndicator } from "./indicator.js";
import type { HealthSnapshot, SourceHealth, Routing } from "../health/index.js";
import type { ConnectorConfig } from "../config/index.js";

/**
 * The narrow DOM surface the render functions touch. The real browser
 * `HTMLElement` and a minimal test fake both satisfy it, so the render logic is
 * unit-tested in the node env without jsdom while still running verbatim in the
 * browser bundle.
 */
export interface ElementLike {
  textContent: string;
  appendChild(child: ElementLike): ElementLike;
  setAttribute(name: string, value: string): void;
  readonly dataset: Record<string, string>;
}

export interface DocumentLike {
  createElement(tag: string): ElementLike;
}

/** Remove every child of a container by exhausting its render, so a re-render
 * replaces rather than appends. Uses textContent="" which clears children in
 * both the real DOM and the test seam. */
function clear(container: ElementLike): void {
  container.textContent = "";
}

/**
 * Paint one row per source into `container`: a colored status dot (the color
 * derived by {@link sourceIndicator} from reachability + routing) plus the
 * source id label. Re-rendering clears prior rows first, so a poll never leaves
 * stale rows behind. Rows are entirely data-driven — no hardcoded source list.
 */
export function renderSources(
  container: ElementLike,
  sources: SourceHealth[],
  routing: Routing,
  doc: DocumentLike,
): void {
  clear(container);
  for (const source of sources) {
    const row = doc.createElement("div");
    row.setAttribute("class", "source-row");

    const dot = doc.createElement("span");
    const color = sourceIndicator(source, routing);
    dot.setAttribute("class", "dot");
    dot.dataset.color = color;
    row.appendChild(dot);

    const label = doc.createElement("span");
    label.setAttribute("class", "source-label");
    label.textContent = source.id;
    row.appendChild(label);

    container.appendChild(row);
  }
}

/**
 * Paint one link per connector into `container`: an anchor whose href is the
 * connector url and whose text is its name, with an optional logo `<img>` when
 * the connector carries a `logo`. Entirely data-driven from the fetched config —
 * adding a connector entry + redeploy is the only way the list changes.
 */
export function renderConnectors(
  container: ElementLike,
  connectors: ConnectorConfig[],
  doc: DocumentLike,
): void {
  clear(container);
  for (const connector of connectors) {
    const link = doc.createElement("a");
    link.setAttribute("class", "connector");
    link.setAttribute("href", connector.url);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");

    if (connector.logo !== undefined) {
      const img = doc.createElement("img");
      img.setAttribute("class", "connector-logo");
      img.setAttribute("src", connector.logo);
      img.setAttribute("alt", `${connector.name} logo`);
      link.appendChild(img);
    }

    const label = doc.createElement("span");
    label.textContent = connector.name;
    link.appendChild(label);

    container.appendChild(link);
  }
}

export interface RefreshLoopOptions {
  /** Fetch one health snapshot (e.g. `GET /healthz`). */
  fetchSnapshot: () => Promise<HealthSnapshot>;
  /** Called with each fetched snapshot (immediate + every interval). */
  onSnapshot: (snapshot: HealthSnapshot) => void;
  /** Poll cadence in ms. */
  intervalMs: number;
}

/**
 * Start a health refresh loop: fetch immediately, then on a fixed interval,
 * handing each snapshot to `onSnapshot`. Returns a stop function that clears the
 * interval. Mirrors `useNodeHealth`'s immediate-fire-then-interval + clearInterval
 * teardown, framework-free so it runs both in the browser and under fake timers.
 */
export function createRefreshLoop(options: RefreshLoopOptions): () => void {
  const tick = (): void => {
    void options.fetchSnapshot().then(options.onSnapshot);
  };

  tick();
  const timer = setInterval(tick, options.intervalMs);

  return () => clearInterval(timer);
}

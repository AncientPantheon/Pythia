import type { Hono } from "hono";
import {
  loadConfigFromDisk,
  type PythiaConfig,
  type ConnectorConfig,
} from "../config/index.js";

export interface ConnectorsDeps {
  /** Load the checked-in config. Injectable so tests avoid disk; defaults to the
   * production disk loader. */
  loadConfig?: () => PythiaConfig;
}

/** Project a config connector to the wire shape: name + url always, logo only
 * when present so the key is absent (not null) when a connector has no logo. */
function toWireConnector(c: ConnectorConfig): ConnectorConfig {
  const wire: ConnectorConfig = { name: c.name, url: c.url };
  if (c.logo !== undefined) wire.logo = c.logo;
  return wire;
}

/**
 * Register `GET /api/v1/connectors`. Returns the checked-in connector list as a
 * `{ connectors: [{name,url,logo?}] }` envelope — a read-only view of static
 * config the landing page fetches once at load. No writes, no signing surface;
 * the body carries only the connector fields.
 */
export function registerConnectors(app: Hono, deps: ConnectorsDeps = {}): void {
  const loadConfig = deps.loadConfig ?? loadConfigFromDisk;

  app.get("/api/v1/connectors", (c) => {
    const config = loadConfig();
    return c.json({ connectors: config.connectors.map(toWireConnector) }, 200);
  });
}

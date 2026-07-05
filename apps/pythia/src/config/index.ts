import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPythiaConfig } from "./loader.js";
import type { PythiaConfig, RawPythiaConfig } from "./types.js";

export {
  loadPythiaConfig,
  PythiaConfigError,
  DEFAULT_FINALITY_DEPTH,
  DEFAULT_READ_GAS_LIMIT,
} from "./loader.js";
export type {
  PythiaConfig,
  RawPythiaConfig,
  SourceConfig,
  ConnectorConfig,
  SourceRole,
} from "./types.js";

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "pythia.config.json",
);

/**
 * Read and validate the checked-in config from disk. Validation only — a
 * violation throws {@link PythiaConfigError} at boot before any request is served.
 */
export function loadConfigFromDisk(path: string = CONFIG_PATH): PythiaConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawPythiaConfig;
  return loadPythiaConfig(raw);
}

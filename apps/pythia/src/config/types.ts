export type SourceRole = "primary" | "fallback";

export interface SourceConfig {
  id: string;
  url: string;
  role: SourceRole;
  chain: string;
}

export interface ConnectorConfig {
  name: string;
  url: string;
  logo?: string;
}

export interface PythiaConfig {
  sources: SourceConfig[];
  connectors: ConnectorConfig[];
  finalityDepth: number;
  /** Browser origins allowed to read through the gateway. Empty/absent → "*". */
  corsOrigins: string[];
}

/**
 * The shape of the checked-in config as read from disk, before validation.
 * Fields are typed loosely on purpose so the loader is the single place that
 * proves the invariants (exactly one primary + one fallback, secure origin-only
 * urls, well-formed connectors).
 */
export type RawPythiaConfig = Omit<PythiaConfig, "corsOrigins"> & {
  corsOrigins?: string[];
};

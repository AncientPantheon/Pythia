import type {
  ConnectorConfig,
  PythiaConfig,
  RawPythiaConfig,
  SourceConfig,
} from "./types.js";

/** Default number of confirmations a read is considered final after. */
export const DEFAULT_FINALITY_DEPTH = 6;

/** Raised on any config-validation violation. Typed so callers can catch it. */
export class PythiaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConfigError";
  }
}

function assertSecureOriginUrl(raw: unknown, sourceId: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PythiaConfigError(
      `Source "${sourceId}" url must be a non-empty string`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PythiaConfigError(`Source "${sourceId}" url is not a valid url: ${raw}`);
  }

  if (parsed.protocol !== "https:") {
    throw new PythiaConfigError(
      `Source "${sourceId}" url must use https (got ${parsed.protocol}//)`,
    );
  }

  // Origin-only: no path, query, or fragment. The dial appends endpoints.
  const isOriginOnly =
    (parsed.pathname === "" || parsed.pathname === "/") &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!isOriginOnly) {
    throw new PythiaConfigError(
      `Source "${sourceId}" url must be origin-only (no path/query/fragment): ${raw}`,
    );
  }

  return raw;
}

function validateSources(raw: RawPythiaConfig): SourceConfig[] {
  if (!Array.isArray(raw.sources)) {
    throw new PythiaConfigError("Config sources must be an array");
  }

  const sources = raw.sources.map((s): SourceConfig => {
    if (typeof s?.id !== "string" || s.id.length === 0) {
      throw new PythiaConfigError("Every source must declare a non-empty id");
    }
    if (s.role !== "primary" && s.role !== "fallback") {
      throw new PythiaConfigError(
        `Source "${s.id}" role must be "primary" or "fallback"`,
      );
    }
    if (typeof s.chain !== "string" || s.chain.length === 0) {
      throw new PythiaConfigError(`Source "${s.id}" must declare a non-empty chain`);
    }
    return {
      id: s.id,
      url: assertSecureOriginUrl(s.url, s.id),
      role: s.role,
      chain: s.chain,
    };
  });

  const primaries = sources.filter((s) => s.role === "primary");
  const fallbacks = sources.filter((s) => s.role === "fallback");

  if (primaries.length !== 1) {
    throw new PythiaConfigError(
      `Config must declare exactly one primary source (found ${primaries.length})`,
    );
  }
  if (fallbacks.length !== 1) {
    throw new PythiaConfigError(
      `Config must declare exactly one fallback source (found ${fallbacks.length})`,
    );
  }

  return sources;
}

function validateConnectors(raw: RawPythiaConfig): ConnectorConfig[] {
  if (!Array.isArray(raw.connectors)) {
    throw new PythiaConfigError("Config connectors must be an array");
  }

  return raw.connectors.map((c): ConnectorConfig => {
    if (typeof c?.name !== "string" || c.name.length === 0) {
      throw new PythiaConfigError("Every connector must declare a non-empty name");
    }
    if (typeof c.url !== "string" || c.url.length === 0) {
      throw new PythiaConfigError(
        `Connector "${c.name}" must declare a non-empty url`,
      );
    }
    const connector: ConnectorConfig = { name: c.name, url: c.url };
    if (c.logo !== undefined) {
      if (typeof c.logo !== "string") {
        throw new PythiaConfigError(
          `Connector "${c.name}" logo must be a string when present`,
        );
      }
      connector.logo = c.logo;
    }
    return connector;
  });
}

/**
 * Parse and validate a raw Pythia config into typed structures.
 *
 * Validation only — no dial, no fetch, no health check. Throws
 * {@link PythiaConfigError} on any violation.
 */
export function loadPythiaConfig(raw: RawPythiaConfig): PythiaConfig {
  if (raw === null || typeof raw !== "object") {
    throw new PythiaConfigError("Config must be an object");
  }

  const sources = validateSources(raw);
  const connectors = validateConnectors(raw);

  const finalityDepth =
    raw.finalityDepth === undefined ? DEFAULT_FINALITY_DEPTH : raw.finalityDepth;
  if (typeof finalityDepth !== "number" || !Number.isInteger(finalityDepth) || finalityDepth < 1) {
    throw new PythiaConfigError("Config finalityDepth must be a positive integer");
  }

  const corsOrigins = validateCorsOrigins(raw);

  return { sources, connectors, finalityDepth, corsOrigins };
}

/**
 * Validate the optional browser CORS allowlist. Absent → an empty list (the CORS
 * layer then serves a permissive wildcard). When present it must be an array of
 * non-empty origin strings; anything else is a boot-time config error.
 */
function validateCorsOrigins(raw: RawPythiaConfig): string[] {
  const value = (raw as { corsOrigins?: unknown }).corsOrigins;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PythiaConfigError("Config corsOrigins must be an array of strings");
  }
  return value.map((origin) => {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new PythiaConfigError(
        "Config corsOrigins must contain only non-empty strings",
      );
    }
    return origin;
  });
}

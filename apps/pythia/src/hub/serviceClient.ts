import { createHmac, randomUUID } from "node:crypto";

/**
 * Signed M2M client for the AncientHub Pythia endpoints (the read-node feed and,
 * later, the usage meter). Every call carries the hub's HMAC envelope IN THE BODY
 * — there are no auth headers. The shared secret is a DEDICATED 64-hex M2M secret
 * (NOT the OIDC client secret) provisioned on the hub's `/hub/pythia-admin` and
 * injected via `PYTHIA_HUB_HMAC_SECRET` at deploy. Calls must egress from Pythia's
 * allowlisted IP (the VPS) or the hub returns 403.
 *
 * Keyless: this signs an HMAC over hub-request metadata to authenticate Pythia to
 * the hub — it never holds a blockchain key and never signs a transaction.
 */

export interface HubSlot {
  /** BARE public IP — the reward-attribution join key; echo it verbatim upstream. */
  id: string;
  /** Direct node endpoint (public IP + host port over TLS) — route reads here. */
  url: string;
  networkId: string;
  operator: string | null;
  atTip: boolean;
  height: number;
}

export interface NodesFeed {
  slots: HubSlot[];
  refreshAfter: number;
}

export interface HubConfig {
  baseUrl: string;
  secret: string;
}

export interface SignedEnvelope {
  signature: string;
  nonce: string;
  timestamp: string;
  payload: unknown;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Deterministic JSON with keys sorted at EVERY depth — both sides must emit
 * byte-identical bytes for the HMAC to verify (hub contract §2.1).
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the §2.1 signed envelope:
 * `signature = HMAC_SHA256(secret, canonical({nonce, payload, timestamp}))`, hex
 * lowercase. `nonce`/`timestamp` are injectable so tests are deterministic.
 */
export function signEnvelope(
  payload: unknown,
  secret: string,
  opts: { nonce?: string; timestamp?: string } = {},
): SignedEnvelope {
  const nonce = opts.nonce ?? randomUUID();
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const signature = createHmac("sha256", secret)
    .update(canonicalize({ nonce, payload, timestamp }))
    .digest("hex");
  return { signature, nonce, timestamp, payload };
}

/**
 * Load the hub M2M config from the environment, or `null` when unconfigured — in
 * which case the feed stays OFF and Pythia serves seed-only (zero regression).
 * The secret is required to enable; the base URL defaults to production.
 */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const secret = env.PYTHIA_HUB_HMAC_SECRET?.trim();
  if (!secret) return null;
  const baseUrl = (env.HUB_BASE_URL?.trim() || "https://ancientholdings.eu").replace(
    /\/+$/,
    "",
  );
  return { baseUrl, secret };
}

function isUsableSlot(s: unknown): s is HubSlot {
  const slot = s as HubSlot;
  return (
    !!slot &&
    typeof slot === "object" &&
    typeof slot.id === "string" &&
    slot.id.length > 0 &&
    typeof slot.url === "string" &&
    slot.url.startsWith("https://") &&
    slot.atTip === true
  );
}

export class HubServiceClient {
  private readonly cfg: HubConfig;
  private readonly fetchImpl: FetchImpl;

  constructor(cfg: HubConfig, fetchImpl?: FetchImpl) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as FetchImpl);
  }

  /**
   * `POST /api/pythia/nodes/` — the usable read-node feed. The trailing slash is
   * REQUIRED (the hub is a Next.js folder route); do not strip it. Returns the
   * usable slots, defensively re-filtered to at-tip https entries.
   */
  async fetchNodes(): Promise<NodesFeed> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/pythia/nodes/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signEnvelope({}, this.cfg.secret)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`hub /nodes ${res.status}: ${detail.slice(0, 160)}`);
    }
    const body = (await res.json()) as Partial<NodesFeed>;
    const slots = Array.isArray(body.slots) ? body.slots.filter(isUsableSlot) : [];
    const refreshAfter =
      typeof body.refreshAfter === "number" && body.refreshAfter > 0
        ? body.refreshAfter
        : 60;
    return { slots, refreshAfter };
  }
}

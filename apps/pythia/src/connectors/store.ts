import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A registered connector — an ecosystem app (OuronetUI, an oracle, …) that reads
 * through Pythia with an API key. Managed at runtime from the `ancient`-gated
 * admin surface and persisted to a JSON file on the mounted volume, so adding a
 * connector no longer means editing a deploy secret by hand.
 *
 * The raw API key is NEVER stored — only its SHA-256 hash (for attribution) and
 * a short display prefix. The key is shown exactly once, at creation.
 */
export interface ConnectorRecord {
  id: string;
  name: string;
  url: string;
  logo?: string;
  /** Whether it appears on the public Connectors tab. */
  isPublic: boolean;
  /** Display hint only, e.g. `pk_live_ab12`. */
  keyPrefix: string;
  /** SHA-256 hex of the raw key — the only stored form of the secret. */
  keyHash: string;
  createdAt: string;
}

/** Admin-facing projection — every field except the secret hash. */
export type ConnectorView = Omit<ConnectorRecord, "keyHash">;

/** Public wire shape — the landing page's Connectors tab. */
export interface PublicConnector {
  name: string;
  url: string;
  logo?: string;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toView(r: ConnectorRecord): ConnectorView {
  const view: ConnectorView = {
    id: r.id,
    name: r.name,
    url: r.url,
    isPublic: r.isPublic,
    keyPrefix: r.keyPrefix,
    createdAt: r.createdAt,
  };
  if (r.logo !== undefined) view.logo = r.logo;
  return view;
}

/**
 * File-backed connector registry. Loads on construction, writes atomically
 * (temp + rename) on every mutation so a crash never leaves a half-written file.
 * Single-process, so an in-memory array is the source of truth.
 */
export class ConnectorStore {
  private records: ConnectorRecord[] = [];
  private readonly filePath: string;

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) this.records = parsed as ConnectorRecord[];
    } catch {
      // Absent or invalid file → start empty. First write materialises it.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Every connector, admin projection (no key hash). Newest first. */
  list(): ConnectorView[] {
    return [...this.records].reverse().map(toView);
  }

  /** Only the connectors flagged public, in the public wire shape. */
  publicList(): PublicConnector[] {
    return this.records
      .filter((r) => r.isPublic)
      .map((r) =>
        r.logo !== undefined
          ? { name: r.name, url: r.url, logo: r.logo }
          : { name: r.name, url: r.url },
      );
  }

  /**
   * Register a connector and mint its API key. The raw key is returned ONCE and
   * only its hash is retained — it can never be read back, only revoked.
   */
  add(input: {
    name: string;
    url: string;
    logo?: string;
    isPublic: boolean;
  }): { view: ConnectorView; apiKey: string } {
    const apiKey = `pk_live_${randomBytes(24).toString("base64url")}`;
    const record: ConnectorRecord = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      isPublic: input.isPublic,
      keyPrefix: apiKey.slice(0, 12),
      keyHash: hashKey(apiKey),
      createdAt: new Date().toISOString(),
    };
    if (input.logo !== undefined) record.logo = input.logo;
    this.records.push(record);
    this.persist();
    return { view: toView(record), apiKey };
  }

  /** Remove a connector by id. Returns whether a record was actually removed. */
  revoke(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Resolve a raw `x-pythia-key` to its connector name for usage attribution,
   * or `undefined` if no registered connector owns it. Constant work per lookup
   * (hash + linear scan over a small set).
   */
  nameForKey(rawKey: string): string | undefined {
    const h = hashKey(rawKey);
    return this.records.find((r) => r.keyHash === h)?.name;
  }
}

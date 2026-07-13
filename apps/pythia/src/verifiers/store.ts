import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The **Verifier registry** — the ancient-admin-managed list of Apollo-ownership
 * verifier locations the Connectors "Verify" popup offers. Each verifier is a web
 * app that serves the generic `/apollo-verify` route (a Codex/OuronetUI/Mnemosyne
 * that holds the user's Apollo keys and signs the ownership challenge).
 *
 * Deliberately NOT seeded — an operator curates their own verifiers (there is no
 * safe universal default, and localhost dev ports vary per machine). Until the
 * admin adds one, the Verify popup shows none. File-backed on the mounted volume
 * with atomic temp+rename, modelled on `txsenders/store.ts`.
 */
export interface Verifier {
  id: string;
  /** Human label shown in the picker (e.g. "Mnemosyne", "Standalone Codex · local"). */
  label: string;
  /** Origin the deep-link targets, e.g. `https://codex.ancientholdings.eu` or
   * `http://localhost:3005`. No trailing slash, no path. */
  baseUrl: string;
  enabled: boolean;
  addedAt: string;
}

/** The public shape exposed to the Verify popup — never any admin-only field. */
export interface PublicVerifier {
  id: string;
  label: string;
  baseUrl: string;
}

export type AddVerifierResult =
  | { ok: true; verifier: Verifier }
  | { ok: false; error: string };

/** Accept only an absolute http(s) origin; strip any path/query/trailing slash so
 * the deep-link is always `<origin>/apollo-verify?…`. Returns null if invalid. */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Origin drops any path, query, hash, and trailing slash.
  return url.origin;
}

export class VerifierStore {
  private verifiers: Verifier[] = [];
  private readonly filePath: string;

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) return;
      // Re-validate every persisted entry (defence-in-depth): a hand-edited or
      // corrupted file must not smuggle a non-object row, a missing field, or a
      // non-origin / `javascript:` baseUrl into `/api/verifiers` (and thence into
      // a browser deep-link). Bad rows are dropped; baseUrl is re-normalized.
      this.verifiers = [];
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") continue;
        const v = raw as Partial<Verifier>;
        const baseUrl = typeof v.baseUrl === "string" ? normalizeBaseUrl(v.baseUrl) : null;
        if (!baseUrl || typeof v.id !== "string" || typeof v.label !== "string") continue;
        this.verifiers.push({
          id: v.id,
          label: v.label,
          baseUrl,
          enabled: v.enabled !== false,
          addedAt: typeof v.addedAt === "string" ? v.addedAt : new Date().toISOString(),
        });
      }
    } catch {
      // Absent/invalid → empty. Admins add verifiers before any are offered.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.verifiers, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** All verifiers (admin view), newest first. */
  list(): Verifier[] {
    return [...this.verifiers].reverse();
  }

  /** The enabled verifiers as the public picker shape. */
  enabled(): PublicVerifier[] {
    return this.verifiers
      .filter((v) => v.enabled)
      .map((v) => ({ id: v.id, label: v.label, baseUrl: v.baseUrl }));
  }

  /** Add a verifier. Validates the URL and rejects a duplicate origin. */
  add(input: { label: string; baseUrl: string }): AddVerifierResult {
    const label = input.label.trim();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!label) return { ok: false, error: "a label is required" };
    if (!baseUrl) return { ok: false, error: "a valid http(s) URL is required" };
    if (this.verifiers.some((v) => v.baseUrl === baseUrl)) {
      return { ok: false, error: "a verifier with that URL already exists" };
    }
    const verifier: Verifier = {
      id: randomUUID(),
      label,
      baseUrl,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    this.verifiers.push(verifier);
    this.persist();
    return { ok: true, verifier };
  }

  /** Remove a verifier by id. Returns whether one was removed. */
  remove(id: string): boolean {
    const before = this.verifiers.length;
    this.verifiers = this.verifiers.filter((v) => v.id !== id);
    if (this.verifiers.length === before) return false;
    this.persist();
    return true;
  }

  /** Enable/disable a verifier. Returns whether one was updated. */
  setEnabled(id: string, enabled: boolean): boolean {
    const v = this.verifiers.find((x) => x.id === id);
    if (!v) return false;
    v.enabled = enabled;
    this.persist();
    return true;
  }
}

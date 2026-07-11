import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { DialNode, FetchImpl } from "../dial/index.js";
import { verifyStore } from "../connectors/verify/store.js";
import { buildChallengeMessage } from "../connectors/verify/canonicalMessage.js";
import {
  readApolloPublicKey,
  type ReadPair,
} from "../connectors/verify/readApolloPublicKey.js";
import { apolloVerify } from "../connectors/verify/apolloVerify.js";

/**
 * Connector-linking ownership verification — the KEYLESS half of "prove you own
 * both Apollo halves before Link unlocks". Pythia mints a challenge, the browser
 * signs it in a wallet/Codex that holds the Apollo key, and Pythia verifies the
 * returned signature against the half's ON-CHAIN Apollo public key
 * (`Apollo.verify`, pure public-data). Pythia never holds a key or signs.
 *
 * Not admin-gated: anyone links their OWN keys. Browser-bound by an httpOnly,
 * HMAC-signed `pythia_link` session cookie (a planted/forged cookie is rejected —
 * no session fixation). Proof state is ephemeral (in-memory, TTL'd, single-use per
 * half). Routes:
 *   - `POST /api/connectors/verify/start`   → issue a nonce for a (standard,smart) pair
 *   - `GET  /connectors/verify/callback`    → verifier redirects here with the signature(s)
 *   - `GET  /api/connectors/verify/status`  → which apollo halves are proven for this session
 */
export interface VerifyDeps {
  /** The hub-fed read pool — the WEAKER fallback trust anchor (documented). */
  pool?: { pickReadPair(): ReadPair | null };
  /** The operator's own Upload-Pool nodes — the PREFERRED trust anchor for the
   * pubkey read (not the externally-fed hub rotation). */
  txSenders?: { enabledNodes(): DialNode[] };
  fetchImpl?: FetchImpl;
}

const LINK_COOKIE = "pythia_link";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: 60 * 60,
} as const;

// Per-process HMAC secret: the session id is minted here and MAC'd, so a cookie
// value the server didn't issue is rejected (defeats fixation via a sibling
// subdomain). Ephemeral by design — a restart just invalidates in-flight sessions
// (the flow is transient; re-verify), so it never needs to be configured/persisted.
const SESSION_HMAC_SECRET = randomBytes(32);

function macOf(sid: string): string {
  return createHmac("sha256", SESSION_HMAC_SECRET).update(sid).digest("base64url");
}
function signSid(sid: string): string {
  return `${sid}.${macOf(sid)}`;
}
/** Return the sid iff the cookie value carries a valid server-issued MAC, else null. */
function readSignedSid(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const sid = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = macOf(sid);
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return sid;
}

/** The verified session id from the cookie, or null (no/invalid cookie). */
function currentSid(c: Context): string | null {
  return readSignedSid(getCookie(c, LINK_COOKIE));
}
/** The session id, minting + setting a fresh signed cookie when absent/invalid. */
function ensureSid(c: Context): string {
  const existing = currentSid(c);
  if (existing) return existing;
  const sid = verifyStore.newSessionId();
  setCookie(c, LINK_COOKIE, signSid(sid), COOKIE_OPTS);
  return sid;
}

/** ₱ = U+20B1 (Standard), Π = U+03A0 (Smart) — classify by code point. */
function isStandardApollo(a: string): boolean {
  return a.codePointAt(0) === 0x20b1;
}
function isSmartApollo(a: string): boolean {
  return a.codePointAt(0) === 0x03a0;
}

/**
 * The {primary, fallback} to read the trust-anchor pubkey from. Prefer the
 * operator's OWN Upload-Pool nodes (so a dishonest hub-advertised node can't forge
 * the pubkey → forge ownership); fall back to the hub read pool only when the
 * Upload Pool is empty.
 */
function trustAnchorPair(deps: VerifyDeps): ReadPair | null {
  const upload = deps.txSenders?.enabledNodes() ?? [];
  if (upload.length >= 1) {
    return { primary: upload[0], fallback: upload.length > 1 ? upload[1] : upload[0] };
  }
  return deps.pool?.pickReadPair() ?? null;
}

/** Verify one half's signature against its on-chain Apollo pubkey; mark proven. */
async function verifyHalf(
  deps: VerifyDeps,
  sid: string,
  account: string,
  nonce: string,
  signature: string,
): Promise<boolean> {
  const pair = trustAnchorPair(deps);
  if (!pair) return false;
  const pubKey = await readApolloPublicKey(pair, account, { fetchImpl: deps.fetchImpl });
  if (!pubKey) return false;
  const message = buildChallengeMessage({ apollo: account, nonce });
  const ok = await apolloVerify(signature, message, pubKey);
  // Consume the (nonce, account) slot ONLY on a valid signature (a bad/typo'd sig
  // must not burn it), and record the proof only on first use — a replayed valid
  // signature within TTL is rejected by consumeHalf and can't refresh the proof.
  if (ok && verifyStore.consumeHalf(nonce, account)) {
    verifyStore.markProven(sid, account);
  }
  return ok;
}

export function registerConnectorVerify(app: Hono, deps: VerifyDeps): void {
  // 1) Issue a challenge for a (standard, smart) pair, bound to this browser.
  app.post("/api/connectors/verify/start", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { standard?: unknown; smart?: unknown }
      | null;
    const standard = typeof body?.standard === "string" ? body.standard : "";
    const smart = typeof body?.smart === "string" ? body.smart : "";
    if (!isStandardApollo(standard) || !isSmartApollo(smart)) {
      return c.json(
        { error: "need one Standard (₱.) and one Smart (Π.) apollo account" },
        400,
      );
    }
    const sid = ensureSid(c);
    const challenge = verifyStore.issue(sid, standard, smart);
    return c.json({ nonce: challenge.nonce, expiresAt: challenge.expiresAt });
  });

  // 2) The verifier redirects the browser back here with a generic `proofs`
  //    array — [{apollo, sig}, …] for whatever accounts it could sign. Verify
  //    each proof whose account belongs to THIS challenge's pair, mark it proven,
  //    then bounce to the tab.
  app.get("/connectors/verify/callback", async (c) => {
    const nonce = c.req.query("challenge") ?? "";
    const sid = currentSid(c) ?? "";
    const challenge = verifyStore.get(nonce);
    // Bind: only the session that requested the challenge can complete it.
    if (challenge && sid && challenge.sessionId === sid) {
      let proofs: Array<{ apollo?: unknown; sig?: unknown }> = [];
      try {
        const raw = c.req.query("proofs");
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) proofs = parsed;
      } catch {
        proofs = [];
      }
      for (const p of proofs) {
        const apollo = typeof p?.apollo === "string" ? p.apollo : "";
        const sig = typeof p?.sig === "string" ? p.sig : "";
        // Only accept a proof for an account THIS challenge was issued for — a
        // verifier can't get an unrelated account marked proven.
        if (sig && (apollo === challenge.standard || apollo === challenge.smart)) {
          await verifyHalf(deps, sid, apollo, nonce, sig);
        }
      }
    }
    // Always return to the Connectors tab; the UI reads /status to light up Link.
    return c.redirect("/#connectors", 302);
  });

  // 3) The UI polls which apollo halves are proven for this session.
  app.get("/api/connectors/verify/status", (c) => {
    c.header("Cache-Control", "no-store");
    const sid = currentSid(c) ?? "";
    return c.json({ proven: sid ? verifyStore.provenAccounts(sid) : [] });
  });
}

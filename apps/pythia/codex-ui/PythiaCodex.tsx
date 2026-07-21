import { useEffect, useRef, useState, type ReactElement } from "react";
import { CodexProvider, useCodexStore } from "@ancientpantheon/codex/provider";
import { useCodex, useCodexAuth } from "@ancientpantheon/codex/hooks";
import { PythiaServerCodexAdapter } from "./adapter.js";
import { CodexShell } from "./CodexShell.js";
import { CodexPortabilityControls } from "./CodexPortabilityControls.js";

/**
 * Pythia's OWN operator codex, mounted for the ancient admin (ported from Mnemosyne's
 * MnemosyneCodex). The SAME real codex-ui, against the server-custody
 * PythiaServerCodexAdapter (master-key sealed via /admin/codex). No upload, no password
 * screen: the machine codex password is fetched from /admin/codex/unlock and applied
 * automatically, so the admin lands on an already-open codex.
 *
 * The single lock/unlock control is the package's own (in the CODEXID row) — Pythia does
 * NOT add a second one in the top bar (the canonical Pantheon codex layout: Download/Load
 * up top, lock/unlock in the identity row). See the Pantheonic Architecture codex spec.
 */

const SESSION_TTL_MINUTES = 60;
const SESSION_EXPIRED_MSG =
  "Your admin session has expired. Reload the page and sign in again to unlock the Codex.";

/** Thrown when /admin/codex/unlock returns 401 — the admin session lapsed (the whole
 *  admin surface is behind the same session cookie), so unlock is impossible until re-login. */
class SessionExpiredError extends Error {
  constructor() {
    super("admin session expired");
    this.name = "SessionExpiredError";
  }
}

async function fetchCodexPassword(): Promise<string> {
  const res = await fetch("/admin/codex/unlock", { credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { ok: true; password: string } | { ok: false; error: string };
  if (!body.ok || !body.password) throw new Error(body.ok ? "empty password" : body.error);
  return body.password;
}

type AuthErrorSetter = (message: string | null) => void;

function AutoUnlockOnReady({ onAuthError }: { onAuthError: AuthErrorSetter }): null {
  const { isReady } = useCodex();
  const { isLocked, authenticate } = useCodexAuth();
  const done = useRef(false);
  useEffect(() => {
    if (!isReady || !isLocked || done.current) return;
    done.current = true;
    void fetchCodexPassword()
      .then((pw) => {
        authenticate(pw, SESSION_TTL_MINUTES);
        onAuthError(null);
      })
      .catch((err: unknown) => {
        // A lapsed session can't be fixed by retrying — surface it and STOP (leave
        // done=true) so we don't hammer /admin/codex/unlock. Transient errors retry.
        if (err instanceof SessionExpiredError) onAuthError(SESSION_EXPIRED_MSG);
        else done.current = false;
      });
  }, [isReady, isLocked, authenticate, onAuthError]);
  return null;
}

function PasswordAutoResolver({ onAuthError }: { onAuthError: AuthErrorSetter }): null {
  const store = useCodexStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = store((s: any) => s.pendingPasswordRequest);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      try {
        const pw = await fetchCodexPassword();
        if (cancelled) return;
        store.getState().actions.submitPasswordRequest(pw, SESSION_TTL_MINUTES);
        onAuthError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        store.getState().actions.cancelPasswordRequest();
        if (err instanceof SessionExpiredError) onAuthError(SESSION_EXPIRED_MSG);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, store, onAuthError]);
  return null;
}

/** A dismiss-free banner shown when the admin session lapsed, with a one-click reload
 *  (reload re-runs the gate → the hub login if still signed out). */
function AuthErrorBanner({ message }: { message: string }): ReactElement {
  return (
    <div className="cxpg-authbanner" role="alert">
      <span>⚠ {message}</span>
      <button type="button" className="cxpg-btn cxpg-btn--sm" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

function CodexBody({ authError }: { authError: string | null }): ReactElement {
  const { isReady, initError } = useCodex();
  if (initError) {
    return (
      <div className="cxpg-app cxpg-landing">
        <div className="cxpg-card cxpg-card--status">
          <p className="cxpg-error" role="alert">Failed to load Pythia&apos;s Codex: {initError.message}</p>
        </div>
      </div>
    );
  }
  if (!isReady) {
    return (
      <div className="cxpg-app cxpg-landing">
        <div className="cxpg-card cxpg-card--status">
          <p className="cxpg-status">Opening the sealed codex…</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {authError ? <AuthErrorBanner message={authError} /> : null}
      <CodexShell
        brand="Pythia Codex"
        badge="server-sealed"
        tagline="Sealed on the server · auto-unlocked · saves live."
        consumerName="Pythia"
        topbarActions={<CodexPortabilityControls />}
      />
    </>
  );
}

export default function PythiaCodex(): ReactElement {
  const adapter = useRef<PythiaServerCodexAdapter | null>(null);
  if (adapter.current === null) adapter.current = new PythiaServerCodexAdapter("main");
  const [authError, setAuthError] = useState<string | null>(null);
  return (
    <CodexProvider
      adapter={adapter.current}
      deviceVariant="main"
      passwordCacheMinutes={SESSION_TTL_MINUTES}
      initialUiSettings={{ passwordCacheMinutes: SESSION_TTL_MINUTES }}
    >
      <AutoUnlockOnReady onAuthError={setAuthError} />
      <PasswordAutoResolver onAuthError={setAuthError} />
      <CodexBody authError={authError} />
    </CodexProvider>
  );
}

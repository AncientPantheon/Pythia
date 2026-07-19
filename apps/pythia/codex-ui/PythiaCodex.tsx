import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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
 */

const SESSION_TTL_MINUTES = 60;

async function fetchCodexPassword(): Promise<string> {
  const res = await fetch("/admin/codex/unlock", { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { ok: true; password: string } | { ok: false; error: string };
  if (!body.ok || !body.password) throw new Error(body.ok ? "empty password" : body.error);
  return body.password;
}

function AutoUnlockOnReady(): null {
  const { isReady } = useCodex();
  const { isLocked, authenticate } = useCodexAuth();
  const done = useRef(false);
  useEffect(() => {
    if (!isReady || !isLocked || done.current) return;
    done.current = true;
    void fetchCodexPassword()
      .then((pw) => authenticate(pw, SESSION_TTL_MINUTES))
      .catch(() => {
        done.current = false;
      });
  }, [isReady, isLocked, authenticate]);
  return null;
}

function PasswordAutoResolver(): null {
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
      } catch {
        if (!cancelled) store.getState().actions.cancelPasswordRequest();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, store]);
  return null;
}

function PythiaLockControl(): ReactElement {
  const { isLocked, authenticate, lock } = useCodexAuth();
  const [busy, setBusy] = useState(false);
  const onUnlock = useCallback(async () => {
    setBusy(true);
    try {
      authenticate(await fetchCodexPassword(), SESSION_TTL_MINUTES);
    } catch {
      /* stays locked; admin can retry */
    } finally {
      setBusy(false);
    }
  }, [authenticate]);

  return isLocked ? (
    <button type="button" className="cxpg-btn cxpg-btn--primary cxpg-btn--sm"
      onClick={() => void onUnlock()} disabled={busy}
      title="Sealed under Pythia's Master Key. Unlock without a password — access is already restricted to the ancient admin.">
      {busy ? "Unlocking…" : "🔓 Unlock with Master Key"}
    </button>
  ) : (
    <button type="button" className="cxpg-btn cxpg-btn--ghost cxpg-btn--sm" onClick={() => lock()}
      title="Hide decrypted views. Operations still auto-unlock with the Master Key when needed.">
      🔒 Lock Codex
    </button>
  );
}

function CodexBody(): ReactElement {
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
    <CodexShell
      brand="Pythia Codex"
      badge="server-sealed"
      tagline="Sealed on the server · auto-unlocked · saves live."
      consumerName="Pythia"
      topbarActions={
        <>
          <CodexPortabilityControls />
          <PythiaLockControl />
        </>
      }
    />
  );
}

export default function PythiaCodex(): ReactElement {
  const adapter = useRef<PythiaServerCodexAdapter | null>(null);
  if (adapter.current === null) adapter.current = new PythiaServerCodexAdapter("main");
  return (
    <CodexProvider
      adapter={adapter.current}
      deviceVariant="main"
      passwordCacheMinutes={SESSION_TTL_MINUTES}
      initialUiSettings={{ passwordCacheMinutes: SESSION_TTL_MINUTES }}
    >
      <AutoUnlockOnReady />
      <PasswordAutoResolver />
      <CodexBody />
    </CodexProvider>
  );
}

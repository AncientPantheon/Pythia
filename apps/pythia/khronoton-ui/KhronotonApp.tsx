import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { KhronotonProvider, createFetchAdapter } from "@ancientpantheon/khronoton-core/provider";
import { Builder, CronotonList, Detail, KhronotonUiRoot } from "@ancientpantheon/khronoton-core/ui";
import type { Access } from "@ancientpantheon/khronoton-core/ui";
import "@ancientpantheon/khronoton-core/ui.css";
import "./khronoton-island.css";

/**
 * Pythia's live Khronoton console — the package's real screens (CronotonList ⇄
 * Detail ⇄ Builder) over the ancient-gated `/admin/khronoton` catch-all (same
 * engine context as the tick loop). The vanilla equivalent of Mnemosyne's
 * KhronotonApp: a plain client mount instead of next/dynamic.
 *
 * - Adapter: `createFetchAdapter("/admin/khronoton")` — mutations carry the
 *   `x-khronoton-confirmed` header once {@link onNeedConfirm} resolves; a 401
 *   `admin_confirm_required` re-prompts exactly once (the package's runGated).
 * - Identity: display-only from Pythia's `/api/me` (the server stamps createdBy).
 * - Theming: `--khr-*` overridden to Pythia's night/gold palette in the island CSS.
 */

type Screen =
  | { view: "list" }
  | { view: "detail"; id: string }
  | { view: "builder"; editId?: string };

function useConfirmGate(): { gate: ReactElement | null; onNeedConfirm: () => Promise<boolean> } {
  const [pending, setPending] = useState<{ resolve: (ok: boolean) => void } | null>(null);

  const onNeedConfirm = useCallback(
    () => new Promise<boolean>((resolve) => setPending({ resolve })),
    [],
  );
  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  const gate = pending ? (
    <div className="pyth-modal-backdrop">
      <div className="pyth-modal cxpg-card" role="alertdialog" aria-modal="true">
        <p className="cxpg-note">
          Confirm this Khronoton action? It changes what the automaton will sign and
          execute on-chain.
        </p>
        <div className="cxpg-codexbar-actions">
          <button type="button" className="cxpg-btn cxpg-btn--primary" onClick={() => settle(true)}>
            Yes, proceed
          </button>
          <button type="button" className="cxpg-btn" onClick={() => settle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { gate, onNeedConfirm };
}

export function KhronotonApp(): ReactElement {
  const [screen, setScreen] = useState<Screen>({ view: "list" });
  const [email, setEmail] = useState<string | undefined>(undefined);
  const { gate, onNeedConfirm } = useConfirmGate();

  useEffect(() => {
    let active = true;
    fetch("/api/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((me: { name?: string }) => {
        if (active) setEmail(me?.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const adapter = useMemo(() => createFetchAdapter("/admin/khronoton"), []);
  const access: Access = useMemo(() => ({ tier: "admin", email }), [email]);

  return (
    <KhronotonUiRoot className="pyth-khronoton">
      <KhronotonProvider adapter={adapter} onNeedConfirm={onNeedConfirm}>
        {gate}
        {screen.view === "list" ? (
          <CronotonList
            access={access}
            onOpen={(id) => setScreen({ view: "detail", id })}
            onEdit={(id) => setScreen({ view: "builder", editId: id })}
            onNew={() => setScreen({ view: "builder" })}
          />
        ) : screen.view === "detail" ? (
          <Detail
            id={screen.id}
            access={access}
            onBack={() => setScreen({ view: "list" })}
            onEdit={(id) => setScreen({ view: "builder", editId: id })}
            onNavigateToList={() => setScreen({ view: "list" })}
          />
        ) : (
          <Builder
            editId={screen.editId}
            access={access}
            onDone={(id) => setScreen(id ? { view: "detail", id } : { view: "list" })}
          />
        )}
      </KhronotonProvider>
    </KhronotonUiRoot>
  );
}

export default KhronotonApp;

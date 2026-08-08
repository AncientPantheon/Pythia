import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { KhronotonProvider, createFetchAdapter } from "@ancientpantheon/khronoton-core/provider";
import type { ServerResolverOption } from "@ancientpantheon/khronoton-core/provider";
import { Builder, CronotonList, Detail, KhronotonUiRoot } from "@ancientpantheon/khronoton-core/ui";
import type { Access } from "@ancientpantheon/khronoton-core/ui";
import "@ancientpantheon/khronoton-core/ui.css";
import "./khronoton-island.css";

/**
 * The Builder's "Server Resolver" dropdown is populated from THIS list — not
 * auto-discovered from the server-side `registerServerResolver()` registry
 * (`apps/pythia/src/automaton/khronoton/register.ts`). Without an entry here, a
 * resolver that's registered and working server-side is simply un-selectable in the
 * admin UI (confirmed live, 2026-08-02 — the dropdown showed only "None (ordinary
 * cronoton)" even though both resolvers below were already registered and firing).
 * The literal `value` strings are hardcoded (not imported) rather than importing
 * `DUAL_LINK_ACTIVATE_RESOLVER`/`PYTH_FLUSH_RESOLVER` from their server-side resolver
 * modules — those modules pull in `@ancientpantheon/khronoton-core/server`'s Node-only
 * surface, which has no place in this browser-bundled island. Keep these two strings in
 * lockstep with `dualLinkActivateResolver.ts`'s `DUAL_LINK_ACTIVATE_RESOLVER` and
 * `pythFlushResolver.ts`'s `PYTH_FLUSH_RESOLVER` by hand if either ever changes.
 */
const SERVER_RESOLVER_OPTIONS: ServerResolverOption[] = [
  {
    value: "pyth-flush",
    label: "Pyth Flush (A_Flush)",
    note: "Fills entries[] from the local Pyth ledger's day-buckets at fire time.",
  },
  {
    value: "dual-link-activate",
    label: "Dual-Link Activate (A_LinkDualApiKey)",
    note:
      "Fills standardApollo/smartApollo from the oldest verified-but-not-yet-active " +
      "pair — a no-op fire when none are ready.",
  },
  {
    value: "dual-link-break",
    label: "Dual-Link Break (A_RevokeLink)",
    note:
      "Fills dualAPI from the oldest ancient-admin-queued revoke — a no-op fire when " +
      "none are queued. Pact: (ouronet-ns.TS01-C4.PYTHIA|A_RevokeLink (read-msg \"dualAPI\")).",
  },
];

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

  const adapter = useMemo(() => {
    const base = createFetchAdapter("/admin/khronoton");
    // WORKAROUND for a khronoton-core 0.6.0 crash (Pythia's deploy auto-adopts
    // @latest): the cronoton LIST projection (`listCodexCronotons`) returns only
    // id/name/schedule_mode/status/next_fire_at/last_fire_at/created_at/
    // modified_at/created_by — it OMITS `pact_code` — yet the package's own
    // <CronotonList> renders `pactPreview(row.pact_code)`, which does
    // `pact_code.replace(/\s+/g, " ")` with no undefined guard. So the whole
    // Khronoton admin page white-screens ("Cannot read properties of undefined
    // (reading 'replace')") the moment the list has ≥1 cronoton. Pythia can't
    // patch the package's component, but it OWNS this adapter — so default
    // `pact_code` to "" on every list row (the preview then reads "(empty)"
    // instead of crashing). Forward-compatible: a fixed package that DOES return
    // pact_code keeps its real value via `?? `. Real fix tracked in
    // docs/HANDOFF-khronoton-cronotonlist-crash.md (khronoton-core 0.6.1).
    return {
      ...base,
      list: async (query?: Parameters<typeof base.list>[0]) => {
        const view = await base.list(query);
        return {
          ...view,
          codexCronotons: view.codexCronotons.map((r) => ({ ...r, pact_code: r.pact_code ?? "" })),
        };
      },
    };
  }, []);
  const access: Access = useMemo(() => ({ tier: "admin", email }), [email]);

  return (
    <KhronotonUiRoot className="pyth-khronoton">
      <KhronotonProvider
        adapter={adapter}
        onNeedConfirm={onNeedConfirm}
        serverResolverOptions={SERVER_RESOLVER_OPTIONS}
      >
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
          // The package's <Builder> only ever LEAVES the screen via a successful
          // Commit (its onDone fires with the new/edited id) — it ships no
          // cancel/back affordance of its own, so opening it (especially to EDIT
          // an existing cronoton) otherwise strands you with no way out but to
          // save. Pythia adds its own Back control in the surrounding chrome: it
          // navigates back to the edited cronoton's detail (or the list, for a
          // brand-new one), discarding any unsaved edits. NB "Save" is the
          // package's own Commit button, which lives on the Builder's Execute tab
          // (the last tab) — it is not missing, just not on every tab.
          <>
            <div className="pyth-khr-backbar">
              <button
                type="button"
                className="cxpg-btn"
                onClick={() =>
                  setScreen(screen.editId ? { view: "detail", id: screen.editId } : { view: "list" })
                }
              >
                ← Back{screen.editId ? " (discard unsaved edits)" : ""}
              </button>
            </div>
            <Builder
              editId={screen.editId}
              access={access}
              onDone={(id) => setScreen(id ? { view: "detail", id } : { view: "list" })}
            />
          </>
        )}
      </KhronotonProvider>
    </KhronotonUiRoot>
  );
}

export default KhronotonApp;

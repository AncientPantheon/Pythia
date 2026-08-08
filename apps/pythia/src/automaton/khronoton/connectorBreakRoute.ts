import type { Context, Hono } from "hono";
import { createAdminGate } from "../../admin/routes.js";
import type { OidcConfig } from "../../admin/oidcConfig.js";
import type { CodexStore } from "../codexStore.js";
import type { PendingBreakTracker } from "../../connectors/auth/pendingBreakTracker.js";
import { fireDualLinkBreakOnce } from "./dualLinkBreakTrigger.js";
import { getKhronotonContext } from "./context.js";

/**
 * `POST /admin/connectors/break` — deactivate ("API Break") an ACTIVE dual link.
 * Part of the KEYED sovereign half (it drives the automaton to fire an on-chain
 * revoke), hence it lives under `automaton/`, not the keyless read face.
 *
 * ANCIENT-only + confirm-required + audited (the same gate+confirm+audit triad as
 * the khronoton force-delete). Body `{ dualLinkKey }` — the 325-char composite key
 * of the link to revoke. Records it on the `PendingBreakTracker` and fires the
 * `dual-link-break` cronoton (→ on-chain `A_RevokeLink(dualAPI)`). If the operator
 * hasn't created that cronoton yet, the break is QUEUED and a clear
 * `503 break_resolver_unregistered` is returned — it fires the moment the cronoton
 * exists (or the operator fires it manually in the Khronoton admin).
 */

/** A well-formed composite `dual-link-key` = 162 (standard) + 1 (BAR) + 162 (smart). */
const DUAL_LINK_KEY_LEN = 325;
/** Confirm header (mirrors the khronoton force-delete's confirm-required pattern). */
const CONFIRMED_HEADER = "x-pythia-confirmed";

export interface ConnectorBreakDeps {
  cfg: OidcConfig;
  codex: CodexStore;
  pendingBreak: PendingBreakTracker;
}

export function registerConnectorBreak(app: Hono, deps: ConnectorBreakDeps): void {
  const gate = createAdminGate(deps.cfg);
  app.post("/admin/connectors/break", gate, async (c: Context) => {
    c.header("cache-control", "no-store");
    if (c.req.header(CONFIRMED_HEADER) !== "1") {
      return c.json({ error: "admin_confirm_required" }, 401);
    }
    const body = (await c.req.json().catch(() => null)) as { dualLinkKey?: unknown } | null;
    const dualLinkKey = body?.dualLinkKey;
    if (typeof dualLinkKey !== "string" || dualLinkKey.length !== DUAL_LINK_KEY_LEN) {
      return c.json(
        { code: "pythia_validation", error: "dualLinkKey must be the 325-char composite dual-link-key" },
        400,
      );
    }

    deps.pendingBreak.recordBreak(dualLinkKey);
    const fired = await fireDualLinkBreakOnce(deps.codex);

    // Audit — best-effort, mirrors force-delete's onAudit.
    const session = c.get("adminSession") as { sub?: string; name?: string } | undefined;
    try {
      const ctx = await getKhronotonContext(deps.codex);
      await ctx.onAudit?.({
        action: "dual_link.break",
        result: fired.ok ? "ok" : "error",
        targetKind: "dual_link",
        targetId: `${dualLinkKey.slice(0, 10)}…${dualLinkKey.slice(-6)}`,
        detail: {
          actor: session?.name ?? session?.sub ?? "ancient",
          fired: fired.ok,
          cronotonMissing: fired.cronotonMissing ?? false,
        },
      });
    } catch {
      /* audit is best-effort */
    }

    if (fired.ok) return c.json({ ok: true, revoked: true }, 200);
    if (fired.cronotonMissing) {
      return c.json(
        {
          ok: false,
          queued: true,
          code: "break_resolver_unregistered",
          error:
            "revoke queued, but no dual-link-break cronoton is registered to fire it — create one (scheduleless) in the Khronoton admin, or fire it there.",
        },
        503,
      );
    }
    return c.json({ ok: false, queued: true, error: fired.error ?? "break fire failed" }, 502);
  });
}

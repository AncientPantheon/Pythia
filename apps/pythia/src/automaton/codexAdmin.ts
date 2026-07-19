import type { Hono } from "hono";
import { createAdminGate } from "../admin/routes.js";
import type { OidcConfig } from "../admin/oidcConfig.js";
import type { CodexStore } from "./codexStore.js";
import { rekeyBackupBlob, NotASnapshotError } from "./codexRekey.js";

/**
 * The ancient-gated Codex organ HTTP surface — the server side of the full Mnemosyne
 * Codex UI (the `@ancientpantheon/codex` server-custody adapter + the load/download/reload
 * flows). Keyed: it is registered from the composition root (index.ts) and lives under
 * `src/automaton/`, so the client request path never reaches it.
 *
 * Routes (mirroring Mnemosyne's `app/api/admin/codex*`):
 *  - `GET/POST/DELETE /admin/codex` — the adapter's loadAll/saveAll/clearAll.
 *  - `GET /admin/codex/unlock` — lean machine-password fetch (auto-unlock / lock).
 *  - `POST /admin/codex/export` — download re-encrypted under an operator-chosen password.
 *  - `POST /admin/codex/import` — load/adopt: re-seal a file under the machine key.
 */
export function registerCodexAdmin(app: Hono, cfg: OidcConfig, codex: CodexStore): void {
  const gate = createAdminGate(cfg);

  app.get("/admin/codex", gate, (c) => {
    c.header("cache-control", "no-store");
    try {
      const password = codex.getOrCreateCodexPassword();
      const backup = codex.loadBackup();
      return c.json({ initialized: backup !== null, password, backup });
    } catch {
      return c.json({ error: "codex storage unavailable — is PYTHIA_MASTER_KEY set?" }, 503);
    }
  });

  app.post("/admin/codex", gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { backup?: unknown } | null;
    if (!body || typeof body.backup !== "string" || !body.backup) {
      return c.json({ error: "backup (non-empty string) required" }, 400);
    }
    try {
      codex.saveBackup(body.backup);
      return c.json({ ok: true, initialized: true });
    } catch {
      return c.json({ error: "codex storage unavailable" }, 503);
    }
  });

  app.delete("/admin/codex", gate, (c) => {
    codex.clearCodex();
    return c.json({ ok: true });
  });

  app.get("/admin/codex/unlock", gate, (c) => {
    c.header("cache-control", "no-store");
    try {
      return c.json({ ok: true, password: codex.getOrCreateCodexPassword() });
    } catch {
      return c.json({ error: "codex storage unavailable" }, 503);
    }
  });

  app.post("/admin/codex/export", gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { newPassword?: unknown } | null;
    const newPassword = body?.newPassword;
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return c.json({ error: "newPassword (>= 8 chars) required" }, 400);
    }
    const backup = codex.loadBackup();
    if (!backup) return c.json({ error: "no codex to export" }, 400);
    try {
      const machinePw = codex.getOrCreateCodexPassword();
      const { blob, skipped } = await rekeyBackupBlob(backup, machinePw, newPassword);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return c.json({ ok: true, filename: `pythia-codex-${stamp}.json`, backup: blob, skipped });
    } catch {
      return c.json({ error: "export failed" }, 500);
    }
  });

  app.post("/admin/codex/import", gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { backup?: unknown; filePassword?: unknown }
      | null;
    if (!body || typeof body.backup !== "string" || typeof body.filePassword !== "string") {
      return c.json({ error: "backup + filePassword required" }, 400);
    }
    try {
      const machinePw = codex.getOrCreateCodexPassword();
      const { blob, skipped } = await rekeyBackupBlob(body.backup, body.filePassword, machinePw);
      codex.saveBackup(blob);
      return c.json({ ok: true, skipped });
    } catch (err) {
      if (err instanceof NotASnapshotError) return c.json({ error: err.message }, 400);
      const name = (err as { name?: string })?.name;
      const msg = err instanceof Error ? err.message : "";
      if (name === "WrongPasswordError" || /password/i.test(msg)) {
        return c.json({ error: "wrong password — nothing was changed" }, 400);
      }
      return c.json({ error: "import failed" }, 500);
    }
  });
}

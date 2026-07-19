import { useCallback, useRef, useState, type ChangeEvent, type ReactElement } from "react";

/**
 * Download + Load for Pythia's server-custody codex (ported from Mnemosyne).
 *  - Download: choose a password (twice) → server re-keys machine-pw → the chosen
 *    password → the browser saves it. The live codex is untouched.
 *  - Load: pick a codex file → enter ITS password → server re-keys file-pw → machine-pw
 *    and adopts it (REPLACES the current codex; page reloads to re-fetch + auto-unlock).
 * Passwords live only in masked inputs + the request body — never logged.
 */

type Modal = { kind: "none" } | { kind: "download" } | { kind: "load"; backupText: string };

export function CodexPortabilityControls(): ReactElement {
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [filePw, setFilePw] = useState("");
  const [ackReplace, setAckReplace] = useState(false);

  const close = useCallback(() => {
    setModal({ kind: "none" });
    setPw1("");
    setPw2("");
    setFilePw("");
    setAckReplace(false);
    setError(null);
    setBusy(false);
  }, []);

  const runDownload = useCallback(async () => {
    setError(null);
    if (pw1.length < 8) return setError("Password must be at least 8 characters.");
    if (pw1 !== pw2) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      const res = await fetch("/admin/codex/export", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: pw1 }),
      });
      const data = (await res.json()) as { ok?: boolean; filename?: string; backup?: string; error?: string };
      if (!res.ok || !data.backup) {
        setError(data.error ?? "Export failed.");
        setBusy(false);
        return;
      }
      const url = URL.createObjectURL(new Blob([data.backup], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename ?? "pythia-codex.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      close();
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  }, [pw1, pw2, close]);

  const onPickFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void file.text().then((backupText) => {
      setError(null);
      setModal({ kind: "load", backupText });
    });
  }, []);

  const runLoad = useCallback(async () => {
    if (modal.kind !== "load") return;
    setError(null);
    if (!filePw) return setError("Enter the uploaded codex's password.");
    if (!ackReplace) return setError("Confirm you understand this replaces the current codex.");
    setBusy(true);
    try {
      const res = await fetch("/admin/codex/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: modal.backupText, filePassword: filePw }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Load failed.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  }, [modal, filePw, ackReplace]);

  return (
    <>
      <button
        type="button"
        className="cxpg-btn cxpg-btn--ghost cxpg-btn--sm"
        onClick={() => setModal({ kind: "download" })}
        title="Download this codex re-encrypted under a password you choose"
      >
        ⭳ Download
      </button>
      <button
        type="button"
        className="cxpg-btn cxpg-btn--ghost cxpg-btn--sm"
        onClick={() => fileRef.current?.click()}
        title="Load an existing codex backup (replaces the current codex)"
      >
        ⭱ Load
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onPickFile}
      />

      {modal.kind !== "none" ? (
        <div className="pyth-modal-backdrop" role="dialog" aria-modal="true">
          <div className="pyth-modal cxpg-card">
            {modal.kind === "download" ? (
              <>
                <h3 className="cxpg-title" style={{ fontSize: "1.1rem" }}>Download codex</h3>
                <p className="cxpg-note">
                  Choose a password for the downloaded file. The codex is re-encrypted under
                  it — you&apos;ll need this password to load it back. The live codex is not changed.
                </p>
                <input className="pyth-modal-input" type="password" autoComplete="new-password"
                  placeholder="New password (min 8 characters)" value={pw1}
                  onChange={(e) => setPw1(e.target.value)} />
                <input className="pyth-modal-input" type="password" autoComplete="new-password"
                  placeholder="Repeat the password" value={pw2}
                  onChange={(e) => setPw2(e.target.value)} />
              </>
            ) : (
              <>
                <h3 className="cxpg-title" style={{ fontSize: "1.1rem" }}>Load codex</h3>
                <p className="cxpg-note">
                  Enter the password of the codex you selected. It will be re-sealed under
                  Pythia&apos;s master key and adopted.
                </p>
                <p className="cxpg-error" style={{ fontSize: "0.85rem" }}>
                  ⚠ This <strong>replaces</strong> the current codex. Download a backup first if you might need it.
                </p>
                <input className="pyth-modal-input" type="password" autoComplete="off"
                  placeholder="Password for the uploaded codex" value={filePw}
                  onChange={(e) => setFilePw(e.target.value)} />
                <label className="pyth-modal-ack">
                  <input type="checkbox" checked={ackReplace} onChange={(e) => setAckReplace(e.target.checked)} />
                  <span>I understand this replaces the current codex.</span>
                </label>
              </>
            )}
            {error ? <p className="cxpg-error" role="alert">{error}</p> : null}
            <div className="pyth-modal-actions">
              <button type="button" className="cxpg-btn cxpg-btn--ghost cxpg-btn--sm" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="cxpg-btn cxpg-btn--primary cxpg-btn--sm"
                onClick={() => void (modal.kind === "download" ? runDownload() : runLoad())} disabled={busy}>
                {busy
                  ? modal.kind === "download" ? "Preparing…" : "Loading…"
                  : modal.kind === "download" ? "Download" : "Load + adopt"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default CodexPortabilityControls;

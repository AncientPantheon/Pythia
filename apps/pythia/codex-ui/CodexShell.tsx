import { useState, type ReactElement, type ReactNode } from "react";
import {
  CodexUiRoot,
  CodexTabs,
  CodexSettingsSection,
  CodexDebouncerPanel,
  ObservationalCodexIdDisplay,
  CodexPasswordPrompt,
} from "@ancientpantheon/codex/ui";

/**
 * The codex dashboard layout (ported from Mnemosyne's CodexShell). Must render INSIDE a
 * <CodexProvider>. Pythia passes `network={undefined}` to CodexSettingsSection — the codex's
 * chain connection is Pythia herself (the keyless gateway); the operator-URL machinery
 * Mnemosyne uses to point at an EXTERNAL Pythia is not needed here.
 */
export interface CodexShellProps {
  brand: string;
  badge: string;
  tagline: string;
  consumerName: string;
  topbarActions: ReactNode;
}

export function CodexShell({
  brand,
  badge,
  tagline,
  consumerName,
  topbarActions,
}: CodexShellProps): ReactElement {
  const [activeView, setActiveView] = useState<"ui" | "settings">("ui");

  return (
    <div className="cxpg-container">
      <CodexUiRoot>
        <CodexPasswordPrompt />
      </CodexUiRoot>

      <div className="cxpg-topbar">
        <div className="cxpg-topbar-left">
          <div className="cxpg-titlerow">
            <h1 className="cxpg-brand">
              <span className="cxpg-brand-mark" aria-hidden="true">◈</span>
              {brand}
            </h1>
            <span className="cxpg-badge">{badge}</span>
            <p className="cxpg-tagline">{tagline}</p>
          </div>
          <div className="cxpg-viewtabs" role="tablist" aria-label="Codex view">
            <button type="button" role="tab" aria-selected={activeView === "ui"}
              className={`cxpg-viewtab${activeView === "ui" ? " cxpg-viewtab--active" : ""}`}
              onClick={() => setActiveView("ui")}>
              Codex UI
            </button>
            <button type="button" role="tab" aria-selected={activeView === "settings"}
              className={`cxpg-viewtab${activeView === "settings" ? " cxpg-viewtab--active" : ""}`}
              onClick={() => setActiveView("settings")}>
              Codex UI Settings
            </button>
          </div>
        </div>
        <div className="cxpg-topbar-right">
          <div className="cxpg-codexbar-actions">{topbarActions}</div>
          <CodexUiRoot>
            <CodexDebouncerPanel />
          </CodexUiRoot>
        </div>
      </div>

      <div className="cxpg-bodycard">
        <CodexUiRoot>
          <ObservationalCodexIdDisplay />
        </CodexUiRoot>
        <div className="cxpg-separator" aria-hidden="true" />
        <CodexUiRoot>
          {activeView === "ui" ? (
            <CodexTabs />
          ) : (
            <CodexSettingsSection consumerName={consumerName} network={undefined} />
          )}
        </CodexUiRoot>
      </div>
    </div>
  );
}

export default CodexShell;

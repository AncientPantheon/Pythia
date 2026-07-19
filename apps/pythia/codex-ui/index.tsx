import { createElement } from "react";
import { createRoot } from "react-dom/client";
import PythiaCodex from "./PythiaCodex.js";
import "@ancientpantheon/codex/ui.css";
import "./codex-island.css";

// Client-only island: mount Pythia's Codex UI into the admin's #codex-island div.
// (Mnemosyne mounts this via next/dynamic({ssr:false}); a plain client mount is the
// vanilla equivalent — the codex store + package init are browser-only.)
function mount(): void {
  const el = document.getElementById("codex-island");
  if (!el || el.dataset.mounted === "1") return;
  el.dataset.mounted = "1";
  createRoot(el).render(createElement(PythiaCodex));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}

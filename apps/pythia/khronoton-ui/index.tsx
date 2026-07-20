import { createElement } from "react";
import { createRoot } from "react-dom/client";
import KhronotonApp from "./KhronotonApp.js";

// Client-only island: mount Pythia's Khronoton console into the admin's
// #khronoton-island div (the vanilla equivalent of Mnemosyne's next/dynamic mount).
function mount(): void {
  const el = document.getElementById("khronoton-island");
  if (!el || el.dataset.mounted === "1") return;
  el.dataset.mounted = "1";
  createRoot(el).render(createElement(KhronotonApp));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}

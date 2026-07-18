// Pantheonic Header — the ONE shared identity-block renderer used by both the
// /admin dashboard (admin.js) and the landing (app.js). Dependency-free ES
// module: pure DOM, no imports. Hub-supplied name/role is untrusted, so every
// text node is set via textContent — never innerHTML — so it can't inject markup.

// Renders the right-hand identity block into `box` from `authState`.
//   opts.adminLink  — when true, an authenticated ancient gets an "Admin" link
//                     (the landing's variant); a non-ancient gets a disabled,
//                     greyed chip explaining the ancient role is required.
//                     The admin page passes false (already inside /admin).
export function renderIdentity(box, authState, opts = {}) {
  if (!box) return;
  box.textContent = "";

  if (authState && authState.authenticated) {
    const roles = Array.isArray(authState.roles) ? authState.roles : [];
    const isAncient = roles.includes("ancient");

    const who = document.createElement("span");
    who.className = "who";
    const nm = document.createElement("b");
    nm.textContent = authState.name || "user";
    who.append("Signed in as ", nm);
    if (roles.length) {
      // Promote `ancient` to the shown role when present; else show the first
      // role. The badge accents only when the shown role is `ancient`.
      const shown = isAncient ? "ancient" : roles[0];
      const badge = document.createElement("span");
      badge.className = "role-badge" + (shown === "ancient" ? " role-badge--ancient" : "");
      badge.textContent = shown;
      who.append(" · ", badge);
    }
    box.append(who);

    if (opts.adminLink) {
      if (isAncient) {
        const admin = document.createElement("a");
        admin.className = "ph-btn ph-btn--ghost";
        admin.href = "/admin";
        admin.textContent = "Admin Dashboard";
        box.append(admin);
      } else {
        // Inert, greyed button — the ancient role is required for the dashboard.
        const chip = document.createElement("span");
        chip.className = "ph-btn ph-btn--ghost";
        chip.setAttribute("aria-disabled", "true");
        chip.title = "Requires the ancient role";
        chip.textContent = "Admin Dashboard";
        box.append(chip);
      }
    }

    const out = document.createElement("a");
    out.className = "ph-btn ph-btn--ghost";
    out.href = "/admin/logout";
    out.textContent = "Log out";
    box.append(out);
  } else {
    const login = document.createElement("a");
    login.className = "ph-btn ph-btn--primary";
    login.href = "/admin/login";
    login.textContent = "Login with AncientHub";
    box.append(login);
  }
}

// Sets the brand's version chip: `v1.6.0` when a version is given, else empty.
export function setVersion(el, version) {
  if (!el) return;
  el.textContent = version ? "v" + version : "";
}

// A themed confirm modal — the in-theme replacement for window.confirm, shared by
// the landing and the admin so no standard browser popups are ever used. Reuses
// the site's .modal-overlay/.modal styling. Resolves true on confirm, false on
// Cancel / Escape / backdrop. Focus moves into the dialog and restores on close.
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
    };
    const done = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey);

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const h = document.createElement("h3");
    h.className = "modal-h";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "modal-note";
    p.textContent = message;

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn--ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(false));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "btn" + (danger ? " btn--danger" : " btn--primary");
    confirm.textContent = confirmLabel;
    confirm.addEventListener("click", () => done(true));
    actions.append(cancel, confirm);

    modal.append(h, p, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    confirm.focus();
  });
}

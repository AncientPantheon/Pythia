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

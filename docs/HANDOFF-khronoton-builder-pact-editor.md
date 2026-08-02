# Handoff: Khronoton Builder — Pact-code syntax highlighting + top/bottom layout

**To:** Khronoton agent (repo: `constructors/Khronoton`, package `@ancientpantheon/khronoton-core`).
**From:** Pythia agent, on the operator's direct request (2026-08-02) after using the Builder screen
live.
**Consumer:** Pythia's admin UI (`apps/pythia/khronoton-ui/KhronotonApp.tsx`) mounts khronoton-core's
own pre-built `<Builder>` component as-is — Pythia has zero ability to make either change below from
her own repo (confirmed by direct investigation of `Builder.tsx`'s current structure, cited below).
Both changes need to land in khronoton-core's own source.

---

## Change 1 — syntax highlighting on the Pact-code editor

**Current state** (`packages/khronoton-core/src/ui/PactCodeMirror.tsx`): the Pact-code field is
already a real `@uiw/react-codemirror` instance (not a plain `<textarea>` — that's only the SSR/
pre-mount fallback), themed to the package's `--khr-*` tokens, with line numbers and active-line
highlight. But it has **zero syntax coloring** — every token (keywords, strings, parens, comments)
renders in the same flat mono color, because the `<CodeMirror>` instance is only ever configured
with `basicSetup` (lines ~63-83):
```tsx
basicSetup={{
  lineNumbers: true,
  foldGutter: false,
  closeBrackets: false,
  autocompletion: false,
  highlightActiveLine: true,
}}
```
No `extensions` prop is passed, and there is no `@codemirror/language`, `@codemirror/lang-*`,
`@lezer/highlight`, or `HighlightStyle`/`syntaxHighlighting()` anywhere in the repo.

**Requested:** the Pact-code editor should have real syntax coloring — the operator's own reference
point is how the separate "OuronetUI" app colors its own Pact-code input. **We don't have access to
that repo to inspect it directly**, so we can't guarantee pixel/color parity — if this ships and
doesn't match, tell us what's different and we'll adjust. Absent that reference, our recommendation:

1. Pact is Lisp-family syntax (s-expressions, `defun`/`let`/`module`-style keywords, string literals,
   `;`-style or `;;`-style comments — confirm the exact comment syntax against the live Pact grammar).
   `@codemirror/lang-*` has no dedicated Pact package. Two viable paths, in order of effort:
   - **Cheapest:** `@codemirror/legacy-modes`'s Scheme mode (`@codemirror/legacy-modes/mode/scheme`)
     via `StreamLanguage.define(scheme)` — close enough to get parens/strings/comments/atoms colored
     correctly for a first pass, since Pact's surface syntax is s-expression-based like Scheme.
   - **More accurate:** a small hand-rolled `StreamLanguage` Pact tokenizer if the Scheme mode
     misclassifies enough Pact-specific syntax (e.g. `@doc`/`@model` annotations, `defcap`/`defschema`
     keywords) to look wrong in practice.
2. Wire a `HighlightStyle` (via `@codemirror/language`'s `HighlightStyle.define([...])` +
   `syntaxHighlighting(style)`) that maps token tags (keyword, string, comment, number, punctuation)
   onto the package's EXISTING `--khr-*` CSS custom properties (or new ones in the same family, if the
   current token set doesn't have enough distinct colors) — so the highlighting respects whatever
   theme a consumer (Pythia, or anyone else) has already applied via `--khr-*` overrides, rather than
   hardcoding colors that could clash. Pythia's own theme overrides live in
   `apps/pythia/khronoton-ui/khronoton-island.css` if useful as a real example of the token values a
   consumer might set.
3. Pass the resulting extension(s) into `<CodeMirror extensions={[...]}>` in `PactCodeMirror.tsx`.

**Dependency fragility worth fixing in the same pass:** `@uiw/react-codemirror`, `@codemirror/state`,
`@codemirror/view` are currently listed only under `devDependencies` in
`packages/khronoton-core/package.json` and marked `external` in `tsup.config.ts` — i.e. khronoton-core
doesn't actually declare them as something a consumer must install. In Pythia's case this only works
today because an unrelated dependency (`@ancientpantheon/codex`) happens to hoist a CodeMirror stack
into the shared `node_modules` that khronoton-core's `import("@uiw/react-codemirror")` then resolves
against. If that hoisting ever stops lining up, the editor silently degrades to the plain `<textarea>`
fallback in production (not a crash, but a real de-feature, and a confusing one to debug from
Pythia's side without knowing this history). Recommend promoting these to real `dependencies` (or at
minimum a documented `peerDependencies` entry) now that the package is about to lean on CodeMirror's
language/highlight extensions too, not just its basic editing chrome.

## Change 2 — Builder layout: top/bottom instead of left/right, editor pinned to ~7 lines with scroll

**Current state** (`packages/khronoton-core/src/ui/builder/Builder.tsx`): the Pact-code editor and
the settings/tabs pane sit side by side in a hardcoded 2-column CSS grid, defined inline (not a CSS
class — no selector exists for a consumer to override):
```tsx
const PANE_WRAP: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  gap: "1rem",
  alignItems: "start",
};
```
applied at the JSX call site as:
```tsx
<div style={PANE_WRAP}>
  <PactCodeEditor
    value={state.pactCode}
    onChange={(pactCode) => setState((s) => ({ ...s, pactCode }))}
    onClear={() => setState((s) => ({ ...s, pactCode: "" }))}
  />
  <div>
    <BuilderHeader ... />
    <div role="tablist" style={TABLIST}>...</div>
    {/* active tab content */}
  </div>
</div>
```
`PactCodeEditor` is called with no `height` prop here, so it falls back to its own internal default
of `460` (px) — full information in `PactCodeEditor.tsx`, not `Builder.tsx`.

**Requested, exactly:** the Pact-code editor moves to the TOP, full width, clamped to about **7 lines
of visible height** (internal scroll once content exceeds that — CodeMirror's own scroller handles
this once given a fixed height/max-height, no separate scroll container needed). Everything else —
`BuilderHeader`, the tab bar, and the active tab's content (Config/Payload/Gas Payer/Signatures/
Execute) — moves BELOW it, full width. This should become **the standard Builder layout**, not a
per-cronoton or per-consumer option — no new prop is needed unless you'd find one useful for your own
reasons; the operator's ask is for one fixed, universal layout.

Concretely: change `PANE_WRAP` to a single-column stack (`display: "flex", flexDirection: "column"`
or `display: "grid", gridTemplateRows: "auto 1fr"`, your call), and pass a `height` prop to
`<PactCodeEditor>` sized to ~7 lines (CodeMirror's default line-height at this package's font-size —
measure it directly against the actual rendered font/size rather than assuming a round number, so 7
lines is accurate, not approximate).

## Acceptance criteria

- [ ] The Pact-code editor visibly colors Pact syntax (keywords, strings, comments, parens/atoms at
      minimum) using the package's existing theme-token convention (`--khr-*`), not hardcoded colors.
- [ ] `@uiw/react-codemirror`/`@codemirror/state`/`@codemirror/view` are real `dependencies` (or
      documented `peerDependencies`), not `devDependencies` marked `external`.
- [ ] The Builder screen renders the Pact-code editor full-width on top, clamped to ~7 lines with
      internal scroll for longer content, and every other Builder control (header, tabs, tab content)
      full-width below it — for every cronoton, not conditionally.
- [ ] `Detail`/`CronotonList` screens are unaffected (this handoff is scoped to `Builder.tsx` +
      `PactCodeMirror.tsx` only).
- [ ] Existing khronoton-core tests still pass; add/update tests covering the new layout structure
      and (if feasible to test) that a syntax-highlighting extension is actually attached.

## Adoption on Pythia's side once shipped

Pythia's deploy script already auto-bumps `@ancientpantheon/khronoton-core` to `@latest` on every
on-box deploy (`deploy/host/pythia-deploy.sh`) — once this ships and is published, it lands on
Pythia's next deploy with **no Pythia-side code change required** for the layout/highlighting
themselves. The one thing worth a follow-up check on Pythia's side once shipped: whether the new
syntax-highlight token set introduces any NEW `--khr-*` CSS variable names Pythia's own
`khronoton-island.css` theme override should also set (to keep Pact-code coloring visually consistent
with the rest of Pythia's night/gold admin theme) — flag the exact new variable names in your own
release notes so this is a quick, targeted follow-up rather than a guess.

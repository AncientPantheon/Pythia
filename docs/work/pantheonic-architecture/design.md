# Pantheonic Architecture — Design (project)

> Establish `websites/Pantheon/docs/pantheonic-architecture/` as the single, curated, versioned
> authority for how every AncientPantheon site is built — functionality, implementation, AND UI — so
> "build Aletheia per the Pantheonic architecture" means "read this folder." Owner-directed, 2026-07-17.

## Problem
The reusable Pantheon standards are scattered and drifting: the automaton blueprint lives in
Mnemosyne, the sealed-vault + rekey crypto in Mnemosyne, the SSO/consumer-login recipes in Pythia,
constructor-package templates in Khronoton, codex architecture in Codex — each written where it was
first *needed*, not where it *belongs*. There is no UI/UX standard at all, so every site's header,
admin, width, and theming are re-guessed (Mnemosyne alone has 3 widths, 2 token vocabularies, and
identity coded twice). A new-site builder has no single place to learn "how we build + how we look."

## Approach
One **curated, organized library** in the Pantheon website repo (its own git repo = the central
authority; git history + an in-folder CHANGELOG give followability). Structure:

```
websites/Pantheon/docs/pantheonic-architecture/
  README.md      # the index — what to read, in what order, to build a new Pantheon site
  CHANGELOG.md   # evolution log
  design/        # UI/UX guideline (NEW): width · tokens · header · admin layout · theming
  automaton/     # how to build an automaton: blueprint, master-key sealed-vault, versioning
  identity/      # hub login everywhere: the SSO service + consumer-login recipe
  organs/        # shared constructor packages: package-blueprint template, codex/khronoton specs
  patterns/      # cross-repo feature reference impls (consumer-key model) — reference, not required
```

**Inclusion principle:** *would a new-site builder need it to build correctly?* → centralize.
A specific feature's wiring or site/package-local state (retainers, v0.1 docs, migrations, package
READMEs) → stays in its repo. Curation is enforced by the README index + section structure so the
library reads as a canon, not a dump.

**Relocation is auditable, not a sweep:** the first topic produces a `doc → destination` MAPPING for
the owner's approval **before any file moves**. Cross-repo moves don't carry git history, so each
moved doc leaves a one-line pointer stub in its origin repo, and every reference (Pythia memory,
retainers, cross-doc links) is repointed to the new central path.

**Alternatives considered:** own repo (rejected — another clone per implementer, overkill); `.docs`
at the AncientPantheon root (rejected — not a clean versioned repo); leave docs where they are + just
index them (rejected — drift persists, no single authority). Curated central library chosen.

## Acceptance criteria (project-level)
- [ ] `websites/Pantheon/docs/pantheonic-architecture/` exists with a README index that lets an agent
      read it and know what to build for a new Pantheon site, plus a CHANGELOG.
- [ ] Every centralized doc is a deliberate choice from an owner-approved mapping; each moved doc
      leaves a pointer stub in its origin repo and all references to it are repointed.
- [ ] The library contains the new **Design Architecture guideline** (width, tokens, header, admin
      layout, theming) as a theme-agnostic contract.
- [ ] Pythia's admin is rebuilt as the **reference implementation** of the guideline (sidebar + pane
      admin, standardized header) and the guideline cites Pythia's real files.
- [ ] No repo's build/tests break from the relocation (reference updates are complete).

## Out of scope
- Migrating Mnemosyne/Aletheia/etc. to the standard (they align up later; this project only writes
  the standard + proves it in Pythia).
- Moving package-specific handoffs into their *package* repos (a separate cleanup, not this).
- Any change to the consumer-key feature itself (its docs may relocate to `patterns/`, unchanged).

## Topics
1. **arch-library** — scaffold the library (README index + CHANGELOG + sections), produce the
   `doc → destination` mapping for approval, relocate the confirmed docs, stub origins, fix refs.
   Shaped now.
2. **design-guideline** — write the flagship Design Architecture doc (width · tokens · header ·
   admin layout · theming), theme-agnostic. Shaped when its turn comes.
3. **pythia-reference-impl** — rebuild Pythia's admin to the guideline (sidebar+pane + standardized
   header, vanilla); the guideline cites it. Shaped when its turn comes.

---
name: multipart-vault-doc
description: Turn a long document — a design doc, spec, plan, report, research write-up, or any sprawling single file — into a navigable multi-part document set in myvault, so it can be absorbed and iterated section by section. Produces an ordered series of short focused notes plus a TOC/index, with internal wikilinks, prev/next navigation, an optional anchored glossary, and inline HTML/SVG visualizations that render in Obsidian; then a copy script publishes it as a main Document note + Null sub-notes referenced by it. Use when Lukas says things like "break this doc into notes I can read through", "split this spec into the vault", "make a multi-part version of this", "turn DESIGN.md into a doc set in my vault", or wants a long artifact restructured for absorption/review. Delegates all vault/mysystem mechanics to the `myvault` skill.
---

# multipart-vault-doc

Convert one long document into a **multi-part, cross-linked document set in myvault**: an
ordered series of short notes (one concept each) + an index/TOC, with internal links, an
optional anchored glossary, and inline visualizations — then publish it into the vault as a
single main note plus referenced sub-notes.

The point is **absorption and iteration**: a 300-line spec is hard to read and re-read; a set of
focused, linked, visual notes is easy to walk through and revise one piece at a time.

## Delegate vault mechanics — do not hardcode them

This skill owns the **structure and authoring workflow**. It does **not** own how the vault works.
For anything touching myvault, mysystem, note types, the create CLI, or the vault path:

- **Load and follow the `myvault` skill.** It is the source of truth for: note types (use the
  **Document** type for the main note and the **Null** type for the sub-notes), the typed-note
  **create** command (including passing the body via stdin), setting `stage: live`, the null-note
  folder, and the vault path env var. These can change — read them from `myvault`, never bake
  literal commands or paths into your output beyond what that skill currently specifies.
- If machine/repo/location context is needed, use **`mysetup-navigator`**.

When you generate the copy script (Step 5), keep its generic logic (slug↔title mapping, link
rewriting, idempotency) inline, but get the actual note-creation invocation from `myvault`.

## When to use

- A long design doc / spec / plan / report / research write-up that Lukas wants to read through
  and then iterate.
- Any single file big enough that section-by-section navigation + visuals + a glossary would
  genuinely help.

## When NOT to use

- Short notes, or content that is already well-chunked — just create one note via `myvault`.
- Content that should stay a single canonical file in a repo (keep the long source too; this
  skill produces a *companion* reading/iteration view, it doesn't replace the source).

## Workflow

### 1. Decompose

Read the source document and break it into an **ordered series of short, focused notes** — one
idea/section per note. Create a local working folder in the current project (e.g.
`<topic>_doc/`) holding:

- `index.md` — the TOC / main doc (becomes the main vault note).
- `00_<slug>.md`, `01_<slug>.md`, … — the sub-notes, zero-padded so they sort.
- optionally `NN_glossary.md` — last in the series.

Aim for notes that each fit on roughly one screen. Prefer more, smaller notes over a few big
ones — granularity is what makes it absorbable. Split a large section into several notes rather
than letting one note sprawl.

### 2. Author each note

- Open with a one-line orienting sentence so the reader knows where they are.
- Distil, don't copy-paste — this is the readable companion, not a verbatim dump.
- **Inline visualizations** where they aid understanding (see "Visualizations" below).
- End every note with a **navigation footer** using local-slug wikilinks:
  `[[index|↑ Index]] · ← [[03_prev|03 · Prev]] · next → [[05_next|05 · Next]]`
- Cross-link related notes inline with `[[NN_slug|alias]]`.

### 3. Glossary (recommended)

Add a glossary note with **one heading per term**, each heading a lowercase-hyphenated anchor so
it can be linked precisely:

```markdown
## union-find
**Union-find.** Plain-language explanation…
```

Then link jargon at **first use** in each note: `[[NN_glossary#union-find|union-find]]`. Keep the
explanations plain and short. Glossary entries may cross-link each other the same way.

### 4. The index / main doc

`index.md` is the entry point and becomes the main vault note. Include: a short framing
paragraph, an optional "at a glance" summary, and an **ordered TOC** of `[[NN_slug|label]]` links
each with a one-line description. If there's a glossary, point to it and note that hard terms are
linked throughout.

### 5. Publish into the vault (copy script)

Generate a script (see `assets/copy_to_vault.py`) that:

1. Holds an **ordered mapping**: local slug → vault note title → note type. The main doc
   (`index`) maps to the title Lukas wants (e.g. "Foo design V2") as a **Document** note; every
   sub-note maps to a distinctively-prefixed title (e.g. "Foo DLD V2 - 00 Overview") as a **Null**
   note, so wikilinks are unambiguous and the set groups together.
2. **Rewrites wikilink targets** from local slugs to vault titles, preserving aliases and `#anchor`
   fragments. Match the token `[[<slug>` (anchored on `[[`) so it also catches
   `[[slug#anchor|alias]]` and the nav-footer links; replace longest slugs first.
3. Creates the notes **via the `myvault` note system** (get the exact create invocation from that
   skill): the main doc as a Document note titled as requested, each sub-note as a Null note in the
   null folder, referenced by the main doc. Set `stage: live`.
4. Is **idempotent and non-destructive** — the vault's `create` refuses to overwrite, so before
   deleting each target note, **copy it to a timestamped tmp backup**
   (`$TMPDIR/multipart-vault-doc-backups/<stamp>/`), then delete and recreate. This backup is
   essential, not optional: Lukas frequently hand-edits these notes in the vault between runs
   (e.g. `==…==` review highlights), and without the backup a re-run **silently destroys** those
   edits. The template already implements this — keep it, and tell Lukas where the backup landed.

After running it, **verify**: every wikilink target resolves to a real note, and every
`#anchor` referenced resolves to a heading in the glossary. (A quick `grep`/`comm` check over the
generated files is enough.)

### Recovering edits lost before backups existed

If a re-run overwrote vault edits and no backup was taken, Obsidian's **File Recovery** core
plugin is the fallback. It keeps periodic snapshots in a leveldb at
`~/.config/obsidian/IndexedDB/app_obsidian.md_*.leveldb` — work on a **copy**, never the live DB.
Note **content is stored UTF-16LE** (path-keys are ASCII), so decode with both byte parities
(`raw.decode('utf-16-le','replace')` and `raw[1:]...`) and grep for the user's distinctive text
(e.g. `==`, `LUKAS`). Reconstruct a note by slicing from its stable `# NN · Heading` to its
`↑ Index]]` footer, then diff (normalizing `[[wikilinks]]`) against the current version to isolate
their additions.

## Visualizations (so they render in Obsidian)

Obsidian's reading view renders inline HTML and SVG. Guidance that renders reliably in both light
and dark themes:

- **Inline `<svg viewBox=… width="100%">`** for box-and-arrow diagrams, trees, layered
  architectures. Give every shape an **explicit fill and stroke** (light fills + dark text read
  fine on any theme background); avoid relying on the page's text color.
- Give arrowhead `<marker>` defs a **unique id per SVG** (e.g. `ah03`) so multiple diagrams on one
  page don't collide.
- **Styled HTML tables / `<div>`** with inline styles for callouts and comparison boxes.
- Mermaid code blocks also render in Obsidian, but inline SVG is the most portable for custom
  box diagrams — prefer it for bespoke visuals.
- Keep diagrams simple and legible; a clear schematic beats a dense one.

## Quality bar

- **Consistent terminology** — pick one name per concept across all notes (don't let the same
  thing be called three things). This is the single biggest absorption killer.
- **One concept per note**, screen-sized.
- **Every link verified** — no dangling wikilinks, no dead `#anchor`s.
- **Keep the long source** alongside the doc set; this is the companion view.
- **Never overwrite vault notes without backing them up first** — Lukas edits in place; the copy
  script must back up before deleting (see step 5.4).
- Re-running the copy script is the loop: edit the local notes, re-run, re-read in the vault.

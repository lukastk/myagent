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
- **Do NOT hard-wrap prose.** Write each paragraph and list-item as a **single unwrapped line**;
  let Obsidian soft-wrap. Fixed-width wrapping is a plain-text/code habit that is wrong here: the
  hard breaks buy nothing in Obsidian, and a wrap that lands inside a `[[wikilink]]` **breaks the
  link** (wikilinks must be on one line). (Hard breaks are fine only where the format needs them —
  blank lines between blocks, list items, table rows, fenced code/SVG.)
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
(e.g. `- [d] me`, `[!me]`). Reconstruct a note by slicing from its stable `# NN · Heading` to its
`↑ Index]]` footer, then diff (normalizing `[[wikilinks]]`) against the current version to isolate
their additions.

## Review loop: comments ↔ responses

Lukas reads and annotates in the vault. Run a **bidirectional margin dialogue** so each of his
comments and your response link to each other via Obsidian **block references**.

**Comment markup — a mysystem module-task + callout.** Lukas marks each query as a mysystem
**module task** `- [d] me` immediately followed by a `> [!me]` callout holding the comment:

```md
- [d] me
> [!me]
> The comment — can span multiple paragraphs, lists, code blocks.
```

The `- [d]` is a mysystem **module task** (it toggles `- [d]` ⇄ `- [A]`). The `- [d] me` line is
the canonical, greppable marker: **harvest with `grep -rn -- "- \[d\] me"`** across the generated
notes. The `> [!me]` callout is block-level (multi-line, lists, code all work), scannable,
collapsible (`> [!me]-`), and block-referenceable — capture the whole callout (the `[!me]` line
plus following `>` lines), not just the first line. Match `me` case-insensitively.

**Your responses** are written as `> [!agent]` callouts — **with NO task-line prefix** (Lukas
retired the `- [d] agent` convention on 2026-07-06; do not add `- [d]`/`- [A]` lines to your own
responses). In multipart-doc review rounds they live in the Claude responses pad (see below);
when Lukas explicitly asks for inline dialogue in a durable pad, reply inline the same way:

```md
> [!agent]
> Your response — may be fully structured (paragraphs, lists, code) via `>` continuation.
```

**After answering a comment, tick its source task** `- [d] me` → `- [A] me` in the generated note,
so handled queries are visibly done. The comment's block id and `↳ response` link go on a
non-quoted line **directly after** the callout (a callout is one block; the trailing `^id`
references it). An optional CSS snippet in `.obsidian/snippets/` can give `[!me]`/`[!agent]` a
distinct colour + icon (target `.callout[data-callout="me"]` / `[data-callout="agent"]` with
`--callout-color` / `--callout-icon`, enabled in `.obsidian/appearance.json`'s `enabledCssSnippets`).

**ALL responses go in the Claude responses pad — never inline in the generated notes.** This is a
firm rule. Wherever the user's comments live (`- [d] me` + `[!me]` callouts across the notes, or a
"my notes" pad), gather **every** answer into the single durable `… - Claude responses` pad and
cross-link with block refs. **Do NOT reply inline with `[!agent]` callouts in the generated
notes** — those notes get regenerated for the next version, so any inline reply is silently lost;
the responses pad survives, keeps the whole dialogue in one readable place, and stays consistent
across rounds. (Inline `[!agent]` threading is acceptable *only within the responses pad itself*,
which is durable.) Ticking the source `- [d] me` task is the in-note signal that a query is
handled; the full answer lives in the pad. Treat unanswered points as tacit agreement only if the
user says so.

**Wiring the dialogue (scripted, with backups):**

1. Create a **response pad** — a *separate, durable* note (NOT one of the generated set, so the
   publish script never regenerates it). Parent it to the Ideation chronology **and add a numbered
   entry for it in the chronology body** — parenting alone is not enough; the chronology's numbered
   list is the index, so every project pad you create (response pad included) gets a line there in
   the same step you create it. **Each answer gets its own `## H2 heading`** (a short
   descriptor, e.g. `## cl-10c · live remote API nodes`), and the answer underneath may be **fully
   structured** — multiple paragraphs, lists, code blocks — NOT a single cramped paragraph
   (readability matters; the heading also gives the pad a navigable outline). Directly under the
   heading put the back-link line carrying the block id —
   `[[<source note>#^lk-<key>|↑ comment]] ^cl-<key>` — so the comment's forward link lands at the
   top of the section. Then the response as a `> [!agent]` callout — no task-line prefix —
   (which may be **fully structured** — multiple paragraphs, lists, code via `>`
   continuation — NOT a single cramped line). (Author **unwrapped** — one line per paragraph —
   per the no-hard-wrap rule.)
2. Tag each source comment in place, and **tick its task**: change `- [d] me` → `- [A] me`, and
   append a forward link + block id on a non-quoted line directly after the callout —
   `[[<response pad>#^cl-<key>|↳ response]] ^lk-<key>`. The block id must be **last** on the line.
   Derive stable keys from the note number + occurrence (e.g. `lk-08a`, `lk-p4`).
3. Do the tagging/ticking with a script that **backs up each file first** and is idempotent (skip
   comments already carrying `^lk-` / already ticked `- [A] me`).
4. **Verify both directions**: every `#^cl-…` referenced from a comment resolves to a block in the
   response pad, and every `#^lk-…` referenced from the response pad resolves to a tagged comment
   (a quick Python set-diff; mind filenames with spaces — glob in Python, don't word-split in sh).

**Freeze publishing during an open review round.** Inline comments live in the *generated* notes,
so re-running the copy script regenerates them clean and drops the comments and their block ids
(the response pad and Lukas's own notes-pad are durable — not regenerated). So: harvest + answer
first; only once a round is resolved do you fold accepted changes into the local source, bump the
version (V2 → V3), and republish clean.

## Ideation chronology

Maintain one **Ideation chronology** pad per project (titled `<Project> - Ideation chronology`): a
numbered list of internal links to each standalone/master document produced, in order of creation
(newest at the bottom). List **master/multipart docs by their top note only** — never the generated
sub-notes they reference. Include the user's *own* docs too (review-notes pads, etc.); if they
create one and mention it but forget to add it, add it for them. Durable (a normal pad, never
regenerated); the fastest "what exists / where are we" index for the project.

**Parenting rules (myvault):**
- Every pad *you* create for the project is parented to the Ideation chronology
  (`parents: ["[[<Project> - Ideation chronology]]"]`) **and added as a numbered line in the
  chronology body**. Both are required — setting the frontmatter parent does NOT put it in the
  index; the numbered list is the index. Do it in the same step you create the pad.
- The Ideation chronology's *own* parent is not assumed — **ask the user** which note it should be
  (typically the project's `mod/` note) and set that.

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

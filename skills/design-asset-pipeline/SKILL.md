---
name: design-asset-pipeline
description: |
  Produce production-grade visual/brand assets — logos & marks, icon sets, motif/pattern
  kits, seamless tilings, design tokens/stylesheets, key visuals, whole design systems, and
  styled page mockups built from them. Use when asked to: design or build a logo / brand
  identity / design system; turn AI-generated or ideation artwork into clean reusable assets;
  make an icon set, UI components, or seamless patterns; "vectorize" / redraw artwork as true
  SVG; or apply a design system to a page. The method: (1) IDEATE with gpt-image-2 raster
  images and iterate with the user — NO SVGs yet; (2) once a direction is LOCKED, redraw as
  TRUE vector via parametric generators (never auto-trace); (3) fan the production out across
  `sesh` subthreads; (4) VERIFY every asset by rendering it to an image and looking at it
  against a reference. All ideation/process/scratch stays under clean subfolders in `_dev/`.
---

# design-asset-pipeline

Orchestrate the production of **polished, reusable visual assets**. The throughline is a
strict order of operations — **ideate (raster) → lock → vectorize → verify → integrate** —
and a working style: fan the work out across long-lived `sesh` coding-agent subthreads, and
**never trust a worker's report — verify every asset by looking at a rendered image.**

This is for *visual/asset* production specifically. The load-bearing idea is that pixels are
something you can *see go wrong*, so verification means rendering and looking, not reading a
status line.

## The order of operations (do not skip or reorder)

### 1. Ideate — raster only, no SVGs

Explore the design space with **gpt-image-2** (OpenAI image API, `OPENAI_API_KEY` in env;
the `gen.py` helper pattern — text-to-image for concepts, image-to-image/edits to iterate off
references and the user's sketches). This stage is about *taste and direction*, so:

- **Do NOT make SVGs or worry about vectors here.** Raster is faster and right for
  exploration. Trying to vectorise during ideation wastes effort on designs that will be
  thrown away.
- Generate **multiple distinct concepts**, then iterate the promising ones with the user
  (recolours, variants, their sketches as image-to-image references).
- Carry each concept through the **full asset suite** — logo, board, assets sheet,
  key-visual, applied-home — not just a logo (a standing user rule). A concept only reads as
  real when you see it applied.
- Show the user thumbnails/galleries to choose from (generate at full size, then thumbnail to
  WebP — full PNGs are large and make galleries crawl).

### 2. Lock

The user picks a direction (and usually specific colours/type). Write the decision down
(see `DECISIONS.md` in the templates). Only now does vector work begin.

### 3. Vectorize & build — the orchestration

Now redraw the locked designs as **production assets**. This is the heavy lifting and where
the multi-agent orchestration + verification gate earn their keep.

**Redraw, don't trace.** AI ideation art is wobbly raster; a clean geometric mark traced by
an auto-vectorizer becomes thousands of anchor points with broken symmetry. Rebuild as TRUE
vector:
- **Geometric marks / motifs / tilings → parametric generators.** One Python generator per
  asset family = the single source of truth (a `Params`/dataclass; every dimension a ratio of
  one base unit; true elliptical-arc `A` path commands, not sampled polylines). Re-runnable.
- **Wordmarks / type → outline the real font** (HarfBuzz shaping for correct kerning →
  fontTools outline extraction), not traced.
- **Tokens/CSS** → author them (the brand is decided); optionally bootstrap a palette from the
  ideation images, but the values are a decision, not an extraction.
- Themeable by contract: ink = `currentColor`, accent = a CSS custom property
  (`var(--pk-accent, …)`); works on light **and** dark.

**Fan out across `sesh` subthreads.** One worker per well-scoped part (tokens, mark, motif
kit, logotype, key-visual, …), spawned with `sesh thread new --agent claude --yolo`
(auto-parented to you). Drive them with file briefs and a monitor loop — see
[`references/orchestration.md`](references/orchestration.md) for the exact commands and
[`references/briefs.md`](references/briefs.md) for the brief templates (`SHARED.md` of
invariants + one `brief-*.md` per worker + `DECISIONS.md` as the cross-worker contract).

- **Sequence by dependency.** Independent parts run in parallel (a wave); dependent parts
  wait (a wordmark needs the chosen font; a key-visual needs the wordmark; a showcase needs
  everything). Explicitly *hold* dependent work rather than letting it race.
- **Workers never `git commit`.** They write only their assigned folder and report concisely
  ("your final message is the handoff"). You integrate.

### 4. Verify — by looking, with a reference (the gate)

**This is the most important step and the reason for the whole skill.** For every asset a
worker returns, *you* render it and look at it:

- Rasterize SVGs (cairosvg) or render HTML (Playwright/Chromium) to PNG, then **Read the
  image**. Do this at the sizes that matter — including the smallest real use (favicons/dots
  at 16px) and large.
- **Compare against the reference** (the locked ideation render, or the thing it must match)
  — a side-by-side or overlay.
- Check the brand invariants every time (no rounded corners, accent used sparingly, no
  off-palette colour, themes on light + dark, text legible).
- **Never accept a worker's self-report.** In practice the report says "verified, looks
  great" while the render shows a real defect (a pattern that vanishes on dark, a low-res
  fallback, a tacky full-bleed background). When you find one, **send it back to the same
  worker thread with precise evidence** (`sesh thread send`) and re-verify. Each correction
  round gets the same rigor as the original.

### 5. Integrate

You (the orchestrator) own everything that crosses worker boundaries: reconcile shared
constants into one spec, assemble the showcase/bible, write the prompt-style commit, deploy
(AppGarden), and update planning docs/memory. Then `sesh thread stop` the finished workers to
free resources.

## Folder hygiene (firm)

**All ideation and process/scratch lives under clean, organized subfolders in `_dev/` — never
the repo root.** A typical layout:

```
_dev/<work>/
├── ideation/        # gpt-image-2 raster concepts + iterations, gen.py (NO svgs here)
├── orchestration/   # SHARED.md, brief-*.md, DECISIONS.md, watch.sh, worker-ids.tsv
└── proofs/          # verification renders (optional)
```

The **final, locked, vectorized assets graduate out of `_dev/`** into their real production
home (e.g. `design/system/` with `tokens/ logo/ motifs/ icons/ ui/ keyvisual/` + a `README`).
Keep that home clean too: one generator per family, proofs alongside, true-vector only.

## Principles (the rules that make it work)

- **Ideate in raster, ship in vector.** Don't vectorize anything until the direction is
  locked.
- **Redraw, never auto-trace** geometric/brand marks.
- **Verify by looking, against a reference; bounce defects with evidence.** The gate is
  yours, not the worker's.
- **Parametric single source of truth** per asset family; re-runnable; themeable via
  `currentColor` + a CSS variable.
- **Sequence by dependency; workers don't commit; the orchestrator integrates.**
- **Briefs are files** (a shared-invariants doc + per-worker briefs + a decisions/contract
  doc), so parallel work composes and is recreatable.
- **Keep it clean:** ideation/process under `_dev/` subfolders; final assets in their real
  home.
- Validate any `.svelte` with the Svelte autofixer MCP; always include a 3×3 montage as a
  seamlessness proof for tilings.

## When to use / not use

Use for any non-trivial visual-asset job: a real logo, an icon set, a motif/pattern system,
a token stylesheet, a key visual, a design system, or applying one to a page. For a one-off
trivial tweak to an existing asset, just do it directly — the orchestration overhead isn't
worth it. The multi-agent fan-out is justified when there are several independent asset
families to produce in parallel and a real quality bar to hold.

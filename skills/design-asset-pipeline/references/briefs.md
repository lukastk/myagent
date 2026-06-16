# Brief templates

Workers are autonomous `sesh` subthreads. They only know what their brief says. Write three
kinds of file under `_dev/<work>/orchestration/`:

- **`SHARED.md`** — invariants every worker obeys (read first by all).
- **`brief-<part>.md`** — one per worker: exact deliverables, paths, quality bar, verification.
- **`DECISIONS.md`** — the cross-worker contract + decisions + open questions (you own it;
  update as you go).

Keep them specific. The single most common failure is a vague brief → a plausible-but-wrong
asset. Spell out the deliverables, the output path, the quality bar, and *how to self-verify*.

---

## `SHARED.md` (template)

```markdown
# <project> visual assets — SHARED brief

You are one of several parallel workers producing <what>. Read this whole file, then your
specific brief (named in your task message).

## The locked identity (FIXED — do not redesign)
<one paragraph: the concept, the mark, the palette with exact hexes, the type, the feel>

## Reference material (study; do NOT trace — ideation art is raster)
- <locked ideation renders, the bible, the house-style generator to match, etc.>

## Hard rules
1. TRUE VECTOR only — real <path>/<circle>, intentional geometry, no auto-trace, no raster.
2. Parametric — one generator = the single source of truth; every dim a ratio of one unit.
3. Themeable — ink = currentColor; accent = var(--<prefix>-accent, #RRGGBB); light AND dark.
4. Verify visually — rasterize/render to PNG (uv run --with cairosvg --with pillow / playwright)
   at multiple sizes incl. the smallest real use; LOOK at every proof; iterate to pixel-correct.
5. Svelte 5 (runes); pass the Svelte autofixer MCP clean.
6. Stay in your assigned folder. Do NOT edit other workers' files.
7. Do NOT git commit. The orchestrator integrates.
8. Colours agree exactly: <the shared hexes / token names — the contract>.
9. Loud errors over silent fallbacks.

## Your final message = the handoff
A concise report: what you produced + exact paths; how you verified; decisions + open
questions; anything the other workers need for consistency.
```

## `brief-<part>.md` (template)

```markdown
# Worker — <part> (<one-line role>)

Read SHARED.md first. <what this part is and why it matters>.

## What it is (study the references first)
<precise description; point at the exact reference images and the house-style generator>

## Deliverables — all under <design/system/<area>/>
1. `<gen>.py` — the parametric generator (Params dataclass; ratios of one unit; true A arcs).
2. `<asset>.svg` (+ variants: mono, small/favicon optical build, lockups…).
3. `<Component>.svelte` — Svelte 5; props for size/accent/variant; autofixer-clean.
4. `verify.py` — rasterize each at <sizes> on paper AND ink; montage proofs; LOOK at them.
5. `README.md` — geometry rationale, params, usage.

## Quality bar
<what "perfect" means here; what to match in the reference; iterate until right>

## Out of scope / coordinate
<what is Wave 2 / orchestrator-owned; constants to reconcile with sibling workers>
```

## `DECISIONS.md` (template)

```markdown
# Decisions & open items

## Locked
- Identity: <name>. Palette: <hexes>. Type: <fonts>. Geometry: <key constants>.
- The token/colour CONTRACT (consumed by every worker): <names → values>.

## Decisions taken
- <date>: <decision + why>.

## Open items for the user
1. <pending choice that needs real data or a human call>.
```

---

## Notes

- The **token/colour contract** in `DECISIONS.md` is what lets parallel workers compose: one
  worker owns the canonical values (e.g. the grey ramp, the accent), the others consume the
  same names/hexes. Declare it up front.
- Always carry brand concepts through the **full asset suite** (logo, board, assets sheet,
  key-visual, applied-home), not just a logo — a standing user preference.
- For a worker that must match a font (wordmark), tell it to **outline with HarfBuzz shaping +
  fontTools** (real kerning), self-hosting the licensed woff2 — not trace.

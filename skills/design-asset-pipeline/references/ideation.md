# Ideation with gpt-image-2, and why you vectorize later

## The flow

1. **Write a brief, not a wireframe-fill.** Feed gpt-image-2 a paragraph about what the thing
   IS (the product, the feeling, the constraints) plus reference images, rather than asking it
   to colour in a wireframe. You get assets with a visual identity, not a filled box.
2. **Generate raster concepts** with `gen.py` (OpenAI image API, `OPENAI_API_KEY` in env):
   - text-to-image for fresh concepts;
   - image-to-image / edits (multiple reference images) to iterate off a chosen concept, a
     prior generation, or the user's own sketch.
3. **Iterate with the user on the raster.** Recolours, variants, motif ideas. Carry each
   concept through the **full asset suite** (logo, board, assets sheet, key-visual,
   applied-home) — a concept only reads as real when applied.
4. **Galleries:** generate at full size, then thumbnail to WebP. Make concepts/generations
   URL-linkable so the user can point at exactly one. Deploy the gallery as an AppGarden static
   for review.

## No SVGs during ideation

Do not vectorize, redraw, or "clean up" anything while exploring. It is wasted effort on
designs that get discarded, and it slows the loop. Raster is the right medium for taste and
direction. **SVG/vector work begins only after the user LOCKS a direction.**

## Why you redraw (not auto-trace) once locked

Auto-vectorizers are good for full-colour illustration but wrong for a clean geometric/brand
mark: tracing a crisp logo yields 5–10× too many anchor points (a simple mark can become
thousands), breaks circles/angles/symmetry, and bakes the AI render's wobble into the path
data permanently. So:

- **Geometric marks, motifs, tilings → parametric generators** (one Python source of truth;
  ratios of a base unit; true `A` arc paths). Provably clean and re-runnable.
- **Wordmarks/type → outline the real licensed font** with HarfBuzz shaping (correct kerning)
  → fontTools outline extraction. Not traced.
- **Full-colour illustration** (the rare case where tracing is fine) → a native-vector
  re-gen or a vectorizer, kept to a small set; or keep it raster with proper alpha.
- **Tokens/CSS** → author from the locked decision; the ideation render is a reference, not a
  source to extract.

The gpt-image render is the **reference you verify the vector asset against** — render the
SVG and put it side-by-side / overlay with the locked raster.

## `gen.py` shape (sketch)

A thin helper over the OpenAI image API with two modes:

- `generate(prompt, size, out)` — text-to-image (concepts).
- `edit(prompt, [refs...], out)` — image-to-image off one or more reference PNGs (iterate).

Disk-cache by prompt+refs hash so re-runs are cheap. Validate generated raster by viewing it;
validate any later SVG by rasterizing (cairosvg) and viewing.

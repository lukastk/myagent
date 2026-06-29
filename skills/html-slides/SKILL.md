---
name: html-slides
description: Build a self-contained HTML slide deck / presentation from content the user supplies (notes, an outline, a doc, a topic). Use when the user asks to "make slides", "create a presentation / slide deck", "turn this into slides", or "build an HTML presentation". Produces one self-contained .html file (no build step, no dependencies) with keyboard navigation, a 16:9 stage that scales to any screen, automatic y-scroll on overflowing slides, and PDF export. Stores each presentation in its own dated subfolder under `_dev/presentations/`.
---

# html-slides

Build a **single self-contained HTML presentation** — no framework, no build step, no
network. The scaffold at `template/presentation.html` is a fixed-aspect (16:9) deck that
scales to fit any window, navigates by keyboard, and **never clips content**: a slide with
too much content gets a vertical scrollbar rather than spilling off the stage.

## Where presentations live

Unless the user says otherwise, every presentation gets its **own subfolder** under
`_dev/presentations/` in the current project, named `YYYY_MM_DD_<slug>`:

```
_dev/presentations/2026_06_29_q3-review/
├── presentation.html      # the deck (the deliverable)
├── assets/                # images, diagrams, data — anything the deck references
└── ...                    # one-off scripts used to build figures, etc.
```

Keep everything a deck needs inside its own folder so it stays portable and copy-able.
If the user names a different location, use that instead.

## Workflow

1. **Get the content.** Work from what the user gives you — an outline, a doc, notes, or a
   topic. If the framing is genuinely ambiguous (audience, length, tone), ask once; otherwise
   draft and iterate. Don't invent facts to fill slides.

2. **Create the folder and copy the scaffold.** Compute the date and slug:
   ```bash
   DIR="_dev/presentations/$(date +%Y_%m_%d)_<slug>"
   mkdir -p "$DIR/assets"
   cp <skill>/template/presentation.html "$DIR/presentation.html"
   ```
   (`<skill>` is this skill's directory.)

3. **Write the slides.** Each slide is one `<section class="slide">`. Edit the `#stage`
   block — replace the example slides, duplicate the block per slide. Rules that matter:
   - **All visible content goes inside `.slide-content`.** That is the scroll region; putting
     content directly in `.slide` will clip it.
   - Use `<section class="slide center">` for title / section-divider slides (content is
     centered).
   - Restyle the whole deck by editing the `:root` CSS variables (colors, padding, fonts,
     slide dimensions). Don't fight the theme slide-by-slide.
   - Reference images as `assets/foo.png` (relative), and keep those files in the folder.
   - Set the `<title>` and the title-slide text.

4. **Prefer less content per slide.** Slides are not documents. If a slide is dense, split it
   into two or move detail to speaker context. Overflow scroll is a *safety net*, not the
   default layout — a slide the audience has to scroll is usually a slide that should have
   been two.

5. **Verify overflow (required).** After drafting, check which slides overflow the 16:9 stage:
   - Quick CLI pass: `node <skill>/scripts/check-overflow.mjs "$DIR/presentation.html"`
   - Or drive it with the Playwright MCP browser: `browser_navigate` to
     `file://$PWD/$DIR/presentation.html`, then `browser_evaluate (() => window.slideOverflow())`
     to get the list of overflowing slides, and `browser_take_screenshot` to eyeball a few.

   For each overflowing slide, decide deliberately: **split or trim it** if the overflow is
   accidental crowding; **leave the scroll** only if the content genuinely belongs together
   (a long code listing, a reference table). The deck handles the scroll automatically — your
   job is to make sure nothing important sits below the fold by accident. Overflowing slides
   are marked at runtime with an accent rule on the right edge.

6. **Show the user.** Tell them the path and how to open it (any browser, or
   `open`/`xdg-open`). Mention: arrow keys / space / click-gutters to navigate, and
   Cmd/Ctrl-P → "Save as PDF" for a one-slide-per-page export.

## The scaffold (what you get for free)

- **Self-contained** — one HTML file, embedded CSS+JS, zero dependencies, works offline and
  from `file://`.
- **16:9 stage** that scales to fit the window (letterboxed), so it looks right on any screen
  and in screenshots.
- **Navigation** — `←/→`, `Space`, `PageUp/Down`, `Home/End`, click the right/left screen
  gutters; a progress bar and `n / total` counter; deep-links via `#3`.
- **Automatic y-scroll** on any slide whose content exceeds the stage — content is never
  clipped.
- **`window.slideOverflow()`** — returns the list of overflowing slides (used by the check
  script and available in the console).
- **Print/PDF** — `@media print` lays out one slide per page at 1280×720.

## Notes

- Don't pull in reveal.js, CDNs, or a bundler — the whole point is a portable single file.
- Inline SVG and `<canvas>`/JS charts are fine and stay self-contained; large binary assets
  go in `assets/`.
- This skill is about *slides*. For prose documents broken into vault notes, use
  `multipart-vault-doc`; for data-viz design principles, `tufte-viz`.

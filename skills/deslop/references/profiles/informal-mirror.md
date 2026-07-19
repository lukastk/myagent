# Profile: informal-mirror (match the user's own informal style)

Rewrite so it sounds like **the user** wrote it casually, not like a generic "human." This is
voice calibration from the user's own samples.

**You need samples.** Use, in priority order:
1. A sample the user pastes inline or points to ("use my style from `<path>`").
2. A configured stash if one exists: check for `~/.config/deslop/samples/` or a path the user
   has mentioned before (see `AGENTS.local.md`). If none and none provided, **ask** the user
   for 1–3 examples of their informal writing rather than guessing.

**Build the profile silently** from the sample(s) — don't narrate it back. Measure:
- **Sentence rhythm** — typical lengths, how often they use fragments.
- **Vocabulary level** — do they write "stuff" and "things," or "elements" and "components"?
  If they write small, don't upgrade them.
- **Punctuation & spelling habits** — parentheticals? ellipses? lowercase-everything?
  exclamation marks? UK or US spelling and quote conventions? Match whatever they use.
- **Transitions** — explicit connectors, or just start the next thought? Which ones recur?
- **Distinctive tics** — recurring openers, signature phrases, how they handle uncertainty.

Then **replace** AI patterns with patterns *from the sample* — don't just remove slop, swap in
their habits. If they start sentences with "honestly" and lowercase their "i," do that. The
target is "a stranger reading this would believe the user typed it," not "clean writing."

---
name: deslop
description: De-AI-ify writing — detect and remove the tells of LLM-generated prose (em-dash overuse, "it's not just X, it's Y", significance inflation, rule-of-three, AI vocabulary like "delve"/"tapestry"/"load-bearing", current-model structural-metaphor and aphorism tells, chatbot artifacts, low-density "treadmill" padding) and rewrite it to sound like a person. Use when asked to humanize / de-slop / remove AI tells, make text sound less AI / less like ChatGPT / less like Claude, clean up AI-sounding writing, or match the user's own voice. Has use-case profiles for scientific, report, prose, email, and matching the user's informal style, plus a scan-only detect/score mode. Grounded in Wikipedia's "Signs of AI writing".
disable-model-invocation: true
---

# deslop — remove the tells of AI writing

Take text that reads like a chatbot wrote it and either **score it** or **rewrite it** so it
reads like a specific human wrote it. The full tell catalog lives in
[`references/patterns.md`](references/patterns.md); each use-case profile is its own file under
[`references/profiles/`](references/profiles/). Read `patterns.md` and **only the one profile
file you need** before you start — don't read all profiles, and don't work from memory of this
file alone.

North star: **LLMs regress to the statistical mean. Humans are specific, weird, and
inconsistent.** The fundamental tell is text that emerges from nowhere, addressed to no one,
with no stake in its claims. If the reader can't picture a particular person behind it, it
isn't done.

**Positive spec beats negative spec.** The strongest recent finding in this area: a model
given a *sample of the target voice* produces more recognisable, less generic output than one
given only a ban-list — voice-matching moves the result more than a model upgrade does. So the
tell catalog is only half the tool. When the user hands you their own writing, or you can find
a sample, match its voice; that's what the profiles (especially `informal-mirror`) are for.
Cutting tells stops text sounding like AI; matching a voice makes it sound like *someone*.

## Two modes

- **rewrite** (default) — produce a de-slopped version. This is what "humanize / de-AI-ify /
  clean this up" means.
- **detect** — scan only. Report the tells found, by pattern, with a 0–100 AI-tell score and
  the highest-impact fixes. No rewrite. Use when the user asks "does this sound AI?", "score
  this", or "what's giving it away?".

## Pick a profile first

The profile decides what replaces the slop and how far to go. Pick one, then read **only that
file**:

| Profile | For | File |
|---|---|---|
| `scientific` | papers, abstracts, grants, cited technical reports | [`profiles/scientific.md`](references/profiles/scientific.md) |
| `report` | business/project reports, briefs, memos, client-facing | [`profiles/report.md`](references/profiles/report.md) |
| `prose` | essays, blog posts, opinion, newsletters (default) | [`profiles/prose.md`](references/profiles/prose.md) |
| `email` | messages to a person | [`profiles/email.md`](references/profiles/email.md) |
| `informal-mirror` | make it sound like *the user* wrote it casually | [`profiles/informal-mirror.md`](references/profiles/informal-mirror.md) |

Take the profile from the request; otherwise infer it from the text. When genuinely torn
between two, ask. Default is `prose`. Read its file before drafting — it lists what to preserve
so you don't gut legitimate prose.

Every profile runs the same de-slop pass: all the tells in `patterns.md` get cut regardless,
and the hard rules below (em-dash cut, artifact strip) always apply. The profile only changes
what replaces them and how far to go.

## The rewrite loop

Always run all four steps. Don't hand back a first draft.

1. **Read & identify.** Scan the input against `references/patterns.md`. Note every cluster of
   tells (and read the profile's "preserve" list so you don't gut legitimate prose).
2. **Draft.** Rewrite per the chosen profile. Cover everything the original covers — five
   paragraphs in, five paragraphs out, unless the profile says to cut padding. Prefer specific
   detail and plain constructions (is/are/has). Vary sentence length.
3. **Diagnose.** Ask out loud: *"What still reads as obviously AI here?"* Answer in a few
   bullets — the residue is usually too-tidy rhythm, plausible-but-fabricated specifics, or a
   slightly slogan-y closer. For recent-model (Claude/Fable) output, the stubborn residue is
   usually §I: structural-metaphor vocabulary ("load-bearing", "the crux", "doing a lot of
   work"), coined terms of art, and aphorism formulas.
4. **Final pass.** Fix the residue. Then **grep the text for `—` and `–`; any hit means it
   isn't done** (see Hard rules).

**Output for rewrite mode:** the final rewrite, then a short "what I changed" line. Include the
intermediate draft + diagnosis bullets only if the user asked to see the work or it's a close call.

## Hard rules (every profile)

- **Zero em/en dashes** in the final output. The em dash is the most reliable formatting tell;
  treat its removal as a hard constraint, not a preference. Replace with a period, comma,
  colon, or parentheses, or restructure (patterns.md §C1). Also catch ` -- ` and ` — `.
- **Strip copy-paste artifacts** unconditionally: citation markup (`citeturn0…`,
  `oai_citation`), `utm_source=chatgpt.com`-style params, unfilled `[placeholders]`
  (patterns.md §G).
- **Preserve meaning and facts.** Never invent specifics to replace vague ones. If a real
  source/number isn't available, cut the claim — don't fabricate a plausible one. (Matches the
  user's standing rule: loud honesty over silent filler.)

## Don't over-correct (false-positive guard)

A clean human writer hits several of these patterns with no AI involved. **Look for clusters,
not isolated hits.** A single em dash, one "however", formal vocabulary, perfect grammar, curly
quotes from an editor, or an unsourced claim are *not*, on their own, evidence of AI. Before
cutting, sanity-check you're not flattening real voice.

**Preserve these human signals** (over-editing destroys what makes prose sound human): specific
hard-to-fabricate detail, mixed feelings and unresolved tension, dated/era-bound references,
defensible word choices, genuine asides and self-corrections, and natural variety in sentence
length. In `prose`, amplify them.

Two editing disciplines:

- **Judge the sense, not the string.** A word on the ban list is banned in its promotional or
  filler sense, not always. "Analytically valuable" making a substantive claim about value
  stays; "valuable insights" as puffery goes. Same word, different call.
- **Editing the user's own writing ≠ de-slopping raw AI output.** When the input is text the
  *user* wrote (not chatbot output), prefer precise, minimal intervention over the full-rewrite
  loop below: change the specific violation and leave the surrounding voice — including
  deliberate tics — intact, and explain each edit so they can overrule it.

## Detect-mode scoring

Report patterns found (by `patterns.md` ID), the offending text, and the fix. Then a 0–100
AI-tell density score — lower is more human:

| Range | Verdict |
|---|---|
| 0–20 | Pristine — reads like a specific person |
| 21–40 | Mostly human — a couple of minor tells |
| 41–60 | Mixed — half-and-half |
| 61–80 | AI-leaning — multiple structural tells |
| 81–100 | Pure chatbot output |

Drive the score by tell-cluster density and low sentence-length variance ("burstiness"), not a
single trigger word. End with the 2–3 highest-impact fixes.

## Provenance

Pattern catalog grounded in [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
(WikiProject AI Cleanup), distilled with practitioner sources through 2026. See `AGENTS.md` in
this repo for how skills are installed; rerun `./install.sh` after editing.

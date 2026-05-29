---
name: dev-experiments
description: Prototyping-first workflow that runs a series of numbered experiments under `_dev/experiments/` to derisk a new tool or feature before any production code is written. Use when starting a greenfield project, when there are multiple risky technical unknowns (external APIs, novel IPC, cross-machine behaviour, agent integrations, etc.), or when Lukas says things like "let's experiment first", "let's prototype X", "before we begin development", or "spike on X". Establishes `_dev/experiments/EXPERIMENTS_PLAN.md` as the index and treats experiment code as throwaway — durable output is the findings.
---

# dev-experiments

A prototyping-first workflow for derisking a new tool or substantial feature before writing production code. Each experiment is a numbered subdirectory under `_dev/experiments/` that answers one focused technical question. The only durable deliverable is the **findings**.

## Always ask before invoking

This is a heavyweight workflow. **Never start it without explicit confirmation from Lukas.** If you think a situation calls for it (greenfield project, several risky unknowns, novel IPC, multi-agent integration, etc.), propose it and wait. Suggested phrasing:

> This feels worth prototyping in `_dev/experiments/` before we write production code. Want me to set that up?

Lukas's own trigger phrases that imply the workflow is wanted:
- "let's experiment with X first"
- "let's prototype X"
- "before we begin development"
- "spike on X"
- "let's figure out X before committing to an approach"

## When to use

- Greenfield CLI, library, or tool where the right architecture isn't obvious.
- 3+ technical unknowns where guessing wrong is expensive: external APIs, protocols, IPC, cross-machine behaviour, agent integrations, novel storage layouts.
- Substantial new feature in an existing codebase that crosses into unfamiliar territory.

## When NOT to use

- Bug fixes.
- Small features in an existing codebase.
- Well-understood refactors.
- Anything where the implementation path is already clear.

## Initial setup

When Lukas confirms, create:

```
_dev/experiments/
  EXPERIMENTS_PLAN.md
```

Then **ask Lukas whether to gitignore experiment code**. Suggested phrasing:

> Should `_dev/experiments/` be gitignored? I can either commit experiment code (so prototypes + plan stay together in history) or add a `.gitignore` containing `*` that keeps only `EXPERIMENTS_PLAN.md` tracked. Heavyweight prototypes with `node_modules/` etc. usually want the latter.

If they choose ignored, write `_dev/experiments/.gitignore`:

```
*
!.gitignore
!EXPERIMENTS_PLAN.md
```

`EXPERIMENTS_PLAN.md` is **always** tracked — it's where the durable findings live.

## Layout

```
_dev/experiments/
  EXPERIMENTS_PLAN.md         # index + findings summaries + decisions log
  00_<slug>/                  # first experiment
    FINDINGS.md               # written when status flips to done
    <prototype-code>          # throwaway
  01_<slug>/
  …
```

Naming rules:
- Two-digit zero-padded prefix (`00_`, `01_`, …).
- `snake_case` slug describing the **question**, not the answer (`pi_storage_and_resume`, not `use_jsonl_for_pi`).
- Each experiment is **always its own subdirectory**, even if the prototype is one file. Consistency beats brevity.

## `EXPERIMENTS_PLAN.md` template

```markdown
# Experiments plan

Throwaway prototyping for <project>. Each experiment is a numbered subdirectory under `_dev/experiments/`. The only deliverable is **learnings** — write them in the experiment's `FINDINGS.md` and add a short summary plus link under the experiment's "Findings" section here. Code from experiments should not be reused in `src/` directly; rewrite once we're confident.

Status legend: `todo` · `in progress` · `done` · `skipped`.

---

## Group A — <theme>

### `00_<slug>`

**Status:** todo

**Questions**
- …

**Deliverable**
- …

**Findings** *(filled in when status → done; full writeup in [`00_<slug>/FINDINGS.md`](00_<slug>/FINDINGS.md))*
- …

---

## Resolved decisions (<YYYY-MM-DD>)

- …

## Still to decide

- …
```

Group experiments by theme when there are more than ~5 (e.g. "Group A — storage", "Group B — IPC"). For smaller plans, a flat list is fine.

## Per-experiment lifecycle

1. **Pick up:** flip status `todo` → `in progress`.
2. **Run:** code lives inside the experiment's directory. Ugly code is fine — scratch READMEs, throwaway shell snippets, hardcoded paths, anything.
3. **Write findings:** when done, create `_dev/experiments/<NN>_<slug>/FINDINGS.md` with the full writeup. Then add a short summary (3–10 bullets) under the experiment's **Findings** section in the plan, linking to `FINDINGS.md`. Flip status to `done (<YYYY-MM-DD>)`.
4. **If abandoned:** flip to `skipped` with one sentence on why. No `FINDINGS.md` needed.

A good `FINDINGS.md` answers:
- What did we learn that affects production design?
- What was surprising or non-obvious?
- What's deferred to a later experiment?
- Which files in this experiment dir are the artifacts worth pointing at?

The summary in `EXPERIMENTS_PLAN.md` is for skimmers — the full reasoning lives in `FINDINGS.md`.

## Decisions log

Whenever Lukas makes a design call during experimentation — terminology, scope cuts, library picks, semantics decisions — append a dated bullet to "Resolved decisions" in `EXPERIMENTS_PLAN.md`. This is the durable record of intent that survives even if all experiment code is later deleted.

Format:

```markdown
## Resolved decisions (2026-05-28)

- **Terminology:** non-live sessions are "detached". Use everywhere.
- **send-to-live without tmux:** errors out; no silent fallback.
- **copy scope:** v1 is same-agent cross-machine only.
```

When decisions cluster on a new date, start a new dated heading; don't backdate. Decisions resolve items from "Still to decide" — move them across when they're locked.

## What NOT to do

- **Don't graduate experiment code into `src/` by copy-paste.** Rewrite, informed by the findings.
- **Don't skip the findings writeup.** The experiment's value is the learning, not the code.
- **Don't expand an experiment's scope mid-flight.** If new questions emerge, open a new numbered experiment.
- **Don't `.gitignore` `EXPERIMENTS_PLAN.md`.** Even when experiment code is ignored, the plan and findings summaries are durable repo content.
- **Don't auto-start this workflow.** Always ask first.

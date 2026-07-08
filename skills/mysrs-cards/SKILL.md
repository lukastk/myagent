---
name: mysrs-cards
description: Author Anki / SRS / spaced-repetition flashcards in the user's vault via mysrs. Use this skill whenever the user asks to create, edit, or organize Anki cards, SRS cards, flashcards, drill cards, or terminal-embedded practice cards — cards are written as [O] tasks in the vault and reconciled into Anki automatically; NEVER write to Anki/anki-api directly.
---

## The one rule

mysrs cards live in the **vault** and are reconciled idempotently into Anki by
`mysrs-server` (on mymain). You author markdown; the system owns Anki. Never
create/edit Anki notes through anki-api directly — removal, updates, and
suspension all flow from the vault source of truth.

## Where cards go

`~/store/obsidian/myvault/mysrs/misc/<topic>.md` — one file per topic
(`git.md`, `vim.md`, …). File frontmatter:

```yaml
---
mysrs-deck: mysrs::Git          # required (deck is auto-created)
mysrs-notetype: mysrs Terminal  # optional file default; omit for "mysrs Basic"
---
```

Per-card overrides exist as attribute bullets under the task line
(`- deck: …`, `- notetype: …`, `- tags: …`).

## Discovering notetypes (and their fields)

```sh
cd ~/mysetup/mysrs && node mysrs-core/dist/cli.js notetypes list --json
# off-mymain: prefix with MYSRS_ANKI_API_URL=https://mymain.tail27f06c.ts.net:8765
```

The visible fields printed are exactly the section names a card can use.

## Card grammar (loose layout)

```markdown
- [O] front text goes on the task line

Body text = the next field (Back).

??

Third field (e.g. Setup for terminal cards).

---
```

- `- [O] …` starts a card; `- [F] …` = suspended (two-way with Anki).
- Sections split on `??` lines and map to visible fields **in order** (task
  line = field 1). Trailing fields may be omitted (become empty); an empty
  section is a lone `??` line. **Named mode**: every section is `?? FieldName`
  and there is NO front on the task line (never mix modes).
- `---` ends the card.
- **Do NOT invent `^…` block anchors** — sync stamps them automatically.
- Optional scheduling window: `🛫 YYYY-MM-DD` (start) / `📅 YYYY-MM-DD` (due)
  on the task line; outside the window the card is suspended.

## Terminal cards (`mysrs Terminal`)

Fields: `Front, Back, Setup, Env`. The card embeds a real shell (per-card tmux
session on mymain). `Setup` is typed into the shell **once, when the session
is created** — use it to build a fixture (keep it one line, `&&`-chained,
ending in `clear`):

```markdown
- [O] git: what does `lg` show here? (run it)

A one-line commit graph across all branches.

??

git init -qb main demo && cd demo && git commit -q --allow-empty -m one && clear

---
```

`Env` (4th field) names a **shared environment**: every card with the same Env
attaches to ONE persistent session (`env-<slug>`, ~24h idle lifetime) instead
of a private one. **The first card opened provisions it** — so give env-mates
identical Setups, or put Setup on one card and leave it empty (lone `??`) on
the rest. Use envs for course-like series where cards build on shared state.

Live examples: `myvault/mysrs/misc/git.md` (basic), `terminal-smoke.md`
(terminal + env demos).

## Syncing & verifying

Reconcile runs hourly and on mysrs-server restart. To sync now and see the
result (created/updated/unchanged counts — verify your cards landed):

```sh
curl -s -X POST https://mymain.tail27f06c.ts.net:8766/v1/programmes/vault/action \
  -H 'content-type: application/json' -d '{"type":"sync-vault"}'
```

Grammar errors (unknown field, too many sections, mixed modes) fail loudly in
the sync result — fix the markdown and re-sync.

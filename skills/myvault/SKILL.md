---
name: myvault
description: Navigate, inspect, and add to myvault (my Obsidian vault) and mysystem. Use whenever a request involves the vault vocabulary — vault, pad, note, scratchpad, or attaching a box to a note — e.g. "write this up in a pad in my vault", "attach this box to the note". Covers note taxonomy, DAG relationships, task statuses, box↔note links, and the mysystem / mysystem-obsidian / obako / vaultiel layers.
---

# Myvault Skill

Use this skill when the user wants to **navigate and understand the system** (vault structure, note taxonomy, commands, and architecture), or to **add to / modify the vault** (create notes, set bodies, attach boxes) — not when they are asking for a single isolated code change.

## Scope map (what lives where)

```text
mysystem/                   Headless app layer: note types, commands, settings, task config, CLI
mysystem-obsidian/          Obsidian plugin layer: Svelte UI, command overrides, views
mysystem-agent/             Agent chat/session bridge
obako/                      Framework submodule (headless + node adapter + obsidian toolkit)
obako/vaultiel/             Vault I/O submodule (Rust core + CLI + node/obsidian bindings)
```

When tracing behavior, start from the app layer (`mysystem*`) and only drop into `obako/` when behavior comes from the framework.

## Safe first steps (read-only)

Prefer these commands first when orienting yourself in a real vault:

```bash
# List available app commands
mysystem --vault "$OBAKO_VAULT_PATH" cmds --list

# Render a note body (executes obako-js/codeblock widgets)
mysystem --vault "$OBAKO_VAULT_PATH" body "path/to/note.md"

# Full note content (frontmatter + rendered body)
mysystem --vault "$OBAKO_VAULT_PATH" content "path/to/note.md"

# Raw source, no rendering
mysystem --vault "$OBAKO_VAULT_PATH" body --source "path/to/note.md"

# Fast frontmatter index (JSONL)
vaultiel --vault "$OBAKO_VAULT_PATH" all-frontmatter --pattern "*.md"
```

Ask before running mutating commands (`create`, `set-content`, `modify-frontmatter`, `delete`, etc.) against a user vault.

## Mysystem taxonomy cheat sheet

### Note types (code → folder)

- `mod` → `mod/` (Module)
- `pln` → `pln/` (Planner)
- `log` → `log/` (Log)
- `cap` → `cap/` (Capture)
- `pad` → `pad/` (Pad)
- `mem` → `mem/` (Memo)
- `dct` → `dct/` (Document)
- `ref` → `ref/` (Reference)
- `nom` → `nom/` (Noema)
- `apx` → `apx/` (Appendix)

Core fields used across note types:
- `parents` (DAG edges)
- `stage` (`draft` / `live` / `archived`)
- `DOC` (Domain of Concern inclusion)
- Consolidation fields (`cons`, `is-hp-cons`, `is-link-cons-only`, `cons-links`)
- `boxes` (boxyard box IDs associated with the note — see "Boxes ↔ notes" below)

### Task symbols

Task states are defined in `mysystem/src/task-config.ts` (regular tasks, module tasks, foreground, notices, deferred/archived/cancelled variants).

### Where taxonomy logic actually lives

- Note type definitions: `mysystem/src/note-types/`
- Base note behavior: `mysystem/src/note-types/mysystem-note.ts`
- Task statuses and metadata fields: `mysystem/src/task-config.ts`
- Command definitions (headless): `mysystem/src/commands/`
- Obsidian-only commands + overrides: `mysystem-obsidian/src/commands/`, `mysystem-obsidian/src/command-overrides/`

## Creating and writing notes

```bash
# Create a typed note (default frontmatter is built from the type's field spec).
# The path includes the type's folder; extra/overriding frontmatter is merged via --frontmatter.
mysystem --vault "$OBAKO_VAULT_PATH" create --type pad "pad/<Title>.md" \
  --title "<Title>" --frontmatter '{"boxes":["<box_id>"]}'

# Set / replace the body (frontmatter preserved).
# GOTCHA: `mysystem set-content <note> -` does NOT read stdin — it writes a literal "-"
# (mysystem issue #2). For stdin, use vaultiel; or just write the .md file directly:
vaultiel --vault "$OBAKO_VAULT_PATH" set-content "pad/<Title>.md" - < body.md
```

For known, complete note content, writing the `.md` file directly (frontmatter + body) is the most reliable approach — the `mysystem`/`vaultiel` CLIs boot per call and should not be run concurrently against the same note.

## Boxes (boxyard) ↔ notes

A "box" is a boxyard-managed project folder; the working directory is often inside one. A note is linked to boxes via the `boxes:` frontmatter array — a list of box IDs (format `TIMESTAMP_SUBID`). Defined in `mysystem/src/note-types/mysystem-note.ts` ("Boxyard box IDs associated with this note"); consumed by the `ms-box-*` shell helpers and the `note-relations` command.

```bash
# Which box is the current working directory?
boxyard which -j | jq -r '.box_id'

# Attach an EXISTING box to a note — no first-class command yet (mysystem issue #3);
# set the `boxes:` frontmatter directly:
vaultiel --vault "$OBAKO_VAULT_PATH" modify-frontmatter "pad/Note.md" boxes '["<box_id>"]'
#   ...or append to an existing list:
vaultiel --vault "$OBAKO_VAULT_PATH" modify-frontmatter "pad/Note.md" boxes '"<box_id>"' --append

# Commands that CREATE a new box and attach it: create-box, create-github-box, create-module-with-box

# Find all notes attached to a given box:
vaultiel --vault "$OBAKO_VAULT_PATH" all-frontmatter --has-key boxes \
  | jq -r --arg id "<box_id>" 'select(.frontmatter.boxes // [] | index($id)) | .path'
```

## Navigation workflow for "how does X work?"

1. **Find the note type / command entrypoint in mysystem first**.
2. **Check plugin override/UI path** in `mysystem-obsidian` if behavior differs in Obsidian.
3. **Drop into obako** only if the behavior is generic framework functionality (command registry, cache, DAG, rendering, settings, task manager).
4. **Drop into vaultiel** only for vault I/O/parsing behavior.

## Obako and vaultiel landmarks

### Obako (framework)

- `obako/obako/src/vault-adapter.ts` — abstraction boundary
- `obako/obako/src/obako-vault.ts` — high-level vault API
- `obako/obako/src/note-dag.ts` — DAG traversal
- `obako/obako/src/notes/` — typed note base classes + frontmatter processing
- `obako/obako/src/commands/command.ts` — command model/registry

### Vaultiel (I/O)

- `obako/vaultiel/vaultiel-cli/src/main.rs` — CLI commands and args
- `obako/vaultiel/vaultiel-rs/src/` — parser + vault operations
- `obako/vaultiel/vaultiel-node/` and `vaultiel-obsidian/` — runtime bindings

## Useful query patterns

```bash
# Find all live module notes in JSONL frontmatter
vaultiel --vault "$OBAKO_VAULT_PATH" all-frontmatter --has-key notetype --where notetype=mod

# Find DOC notes quickly with jq
vaultiel --vault "$OBAKO_VAULT_PATH" all-frontmatter --has-key DOC \
  | jq -c 'select(.frontmatter.DOC == true)'

# Inspect one note deeply
vaultiel --vault "$OBAKO_VAULT_PATH" inspect "mod/Some Module.md"
```

## Reference files to read for system questions

From this skill directory, repo root is `../..`.

- `../../CLAUDE.md` — complete mysystem architecture/taxonomy guide
- `../../README.md` — high-level package overview
- `../../mysystem/src/note-types/` — type-specific field specs and defaults
- `../../mysystem/src/task-config.ts` — task symbols/status mapping
- `../../mysystem-obsidian/src/plugin.ts` — plugin wiring and overrides
- `../../obako/CLAUDE.md` — framework architecture and boundaries

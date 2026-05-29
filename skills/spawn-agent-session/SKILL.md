---
name: spawn-agent-session
description: Create a new tmux session for a boxyard box on the mysystem socket and launch a coding agent (Claude Code, Pi, or Codex) inside it. Uses mysystem's module-aware session naming convention so the new session is interchangeable with one created via ms-enter-doc-box. Use when Lukas asks to "start a CC session for X", "open a new pi session in box Y", "launch a coding agent for the sesh box", or similar. Precursor to `sesh new --ai <agent>` (github.com/lukastk/sesh, Phase 2) — once sesh ships, deprecate this skill in favour of it.
---

# spawn-agent-session

Create a new tmux session for a boxyard box and launch a coding agent in it, following mysystem's session-naming conventions.

## Inputs (typical)

- **Box identifier**: a box name (e.g. `sesh`), full index_name (`20260527_ms6lpt__sesh`), or absolute path to the box dir.
- **Agent**: `claude` | `pi` | `codex`.
- *(optional)* tmux socket — defaults to `mysystem`.
- *(optional)* session name override — defaults to the convention below.

## Session-naming convention

Mirrors `ms-enter-doc-box` in `~/mysetup/mysystem/mysystem-shell/cmds/enter.sh`:

Every session name ends with ` <<box_id>>` (the box id in angle brackets) so
it stays unique even when two boxes share a name.

- **Box attached to a mysystem note** (mod/pad/etc.): `<box_name> ([<note_type>] <note_name>) <<box_id>>`.
  - Example: `sesh ([mod] sesh) <20260527_ms6lpt>` — box `sesh` attached to `mod/sesh.md`.
- **Box attached to a note that has no `notetype`**: `<box_name> (<note_name>) <<box_id>>`.
- **Standalone box** (no attachment): `<box_name> <<box_id>>`.

Where:
- `note_type` comes from the attached note's `notetype` frontmatter.
- `note_name` is the attached note's filename without `.md`.
- `box_name` is the part after `__` in the index_name (`20260527_ms6lpt__sesh` → `sesh`).
- `box_id` is the part before `__` in the index_name (`20260527_ms6lpt__sesh` → `20260527_ms6lpt`).

## Agent commands — Lukas's preferences

| Agent | Command | Notes |
|---|---|---|
| `claude` | `claude --dangerously-skip-permissions` | **Always pass the bypass flag.** Standing preference. |
| `pi` | `pi` | |
| `codex` | `codex` | |

## Workflow

### 1. Resolve the box

```bash
# By name (most common). If multiple matches, fzf-pick.
INDEX_NAME=$(boxyard list | grep -- "__<NAME>$")
# If multiple lines, pick interactively or ask Lukas.

# Or by full index_name — use directly.
# Or by dir — basename is the index_name.

BOX_ID="${INDEX_NAME%%__*}"   # e.g. 20260527_ms6lpt
BOX_NAME="${INDEX_NAME#*__}"  # e.g. sesh
BOX_DIR="$HOME/dev/$INDEX_NAME"   # boxes' user_boxes_path per ~/.config/boxyard/config.toml
```

Verify the box is included locally: `[ -d "$BOX_DIR" ]`. If not, ask Lukas (might need `boxyard include`).

### 2. Find the module attachment (for session naming)

Search the vault for any note that has the box_id under its `boxes:` frontmatter:

```bash
ATTACHED_NOTE=$(rg -l --type md "^  - ${BOX_ID}$" "$OBSIDIAN_MYVAULT_PATH" 2>/dev/null | head -1)
```

If a match is found:
```bash
NOTE_NAME=$(basename "$ATTACHED_NOTE" .md)
NOTE_TYPE=$(rg -m1 "^notetype:\s*(\S+)" "$ATTACHED_NOTE" -or '$1' 2>/dev/null)

if [ -n "$NOTE_TYPE" ]; then
  SESSION_NAME="${BOX_NAME} ([${NOTE_TYPE}] ${NOTE_NAME}) <${BOX_ID}>"
else
  SESSION_NAME="${BOX_NAME} (${NOTE_NAME}) <${BOX_ID}>"
fi
```

If no match (standalone box):
```bash
SESSION_NAME="${BOX_NAME} <${BOX_ID}>"
```

If **multiple** matches: ask Lukas which note should own the session.

### 3. Compose the agent command

```bash
case "$AGENT" in
  claude) AGENT_CMD="claude --dangerously-skip-permissions" ;;
  pi)     AGENT_CMD="pi" ;;
  codex)  AGENT_CMD="codex" ;;
  *) echo "unknown agent: $AGENT" >&2; exit 1 ;;
esac
```

### 4. Create the session and launch

```bash
SOCKET="${SOCKET:-mysystem}"

if tmux -L "$SOCKET" has-session -t "=$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' already exists — not recreating."
else
  tmux -L "$SOCKET" new-session -d -s "$SESSION_NAME" -c "$BOX_DIR"
  echo "Created session: $SESSION_NAME"
fi

# Brief pause so the shell loads and PATH resolves the agent binary.
sleep 0.5

tmux -L "$SOCKET" send-keys -t "$SESSION_NAME" "$AGENT_CMD" Enter
```

Don't attach automatically — let Lukas use his existing flow (prefix+s, mms-*, etc.).

### 5. Report

Print a short summary:

```
Session: [mod] sesh (sesh)
Box dir: /Users/lukas/dev/20260527_ms6lpt__sesh
Agent:   claude (with --dangerously-skip-permissions)
Socket:  mysystem
Attach:  tmux -L mysystem switch-client -t "[mod] sesh (sesh)"
```

## Notes

- If the box isn't attached to any note, the session is named `<box_name> <<box_id>>` — same as `ms-enter-box-by-name` would produce.
- If the session already exists, **don't recreate or relaunch the agent** — just print where to find it. Running `claude` a second time in a window that already has it would stack processes.
- The socket can be overridden if Lukas explicitly asks for a non-`mysystem` server.
- This skill is a stop-gap. Once `sesh new --ai <agent>` exists (see `github.com/lukastk/sesh` PLAN.md Phase 2), prefer that — it captures the spawned session's agent ID and registers it for liveness tracking.

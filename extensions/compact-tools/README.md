# compact-tools

Compact tool rendering for Pi, now with a keyboard-driven split-pane tool-output viewer.

## What it does

Overrides built-in shell/file tools so collapsed view stays minimal:

- always: `bash`, `write`, `find`, `grep`, `ls`
- optional: `read`, `edit` (disabled by default to avoid conflict with `pi-hashline-edit`)

Plus:

- one-line tool call summaries
- tiny result summaries in collapsed mode (counts/status)
- full output in expanded mode (`Ctrl+O`)
- right-side split pane for browsing tool outputs
- left/right navigation between tool calls in the pane
- pane view shows both invocation (tool + arguments) and output
- selected tool call highlight in transcript while pane is open
- errors are still visible in collapsed mode
- split pane indexes tool results from the current session branch (including after reopen)
- split pane tracks `read`/`edit` tool results even when their render overrides are disabled

## Keybindings / commands

- `Ctrl+O` — global expand/collapse tool output
- `Ctrl+Alt+O` — open split pane
- `/tool-pane` — open split pane
- if terminal shortcut handling differs, run `/tool-pane`

Inside split pane:

- `←` / `→`: previous / next tool call
- `↑` / `↓`, `PageUp` / `PageDown`, `Home` / `End`: scroll output
- `Esc`: close pane

## Run directly

```bash
pi -e ./extensions/compact-tools
```

## Optional `read` + `edit` overrides

```bash
PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT=1 pi -e ./extensions/compact-tools
```

## Install into your local Pi setup

```bash
./install.sh
```

Then reload Pi with `/reload`.

## Note

Split-pane content shows the full text returned by tool results, but cannot recover content already truncated upstream by tool limits.

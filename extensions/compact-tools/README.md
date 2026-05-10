# compact-tools

Compact tool rendering extension for Pi.

## What it does

Overrides built-in shell/file tools so collapsed view stays minimal:

- always: `bash`, `write`, `find`, `grep`, `ls`
- optional: `read`, `edit` (disabled by default to avoid conflict with `pi-hashline-edit`)

- one-line tool call summaries
- tiny result summaries in collapsed mode (counts/status)
- full output only in expanded mode
- errors are still visible in collapsed mode

Use `Ctrl+O` to toggle expanded tool output.

If you want compact rendering for `read` and `edit` too (and are not using another extension that overrides them), start Pi with:

```bash
PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT=1 pi -e ./extensions/compact-tools
```

## Run directly

```bash
pi -e ./extensions/compact-tools
```

## Install into your local Pi setup

```bash
./install.sh
```

Then reload Pi with `/reload`.

---
name: tui-tmux-testing
description: Test interactive terminal/TUI programs safely using an isolated tmux server on a temporary socket. Use when running, inspecting, debugging, or sending keystrokes to curses/terminal UIs without disturbing the user's tmux sessions.
---

# TUI tmux testing

Use this skill when you need to run an interactive terminal UI, observe its screen output, send keystrokes, and verify behavior. The goal is to test TUIs in a real pseudo-terminal while keeping the user's normal terminal and tmux servers untouched.

## Core rule

Always create a fresh tmux server using a temporary socket. Never use the default tmux socket and never use the user's named sockets such as `mysystem`.

Every tmux command in this workflow must include `-S "$socket"`.

## Start an isolated TUI session

From the project directory, create a temporary work directory and isolated tmux server:

```zsh
workdir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-test.XXXXXX")"
socket="$workdir/tmux.sock"
session="tui"
target="$session:0.0"

# Start with no user tmux config so tests are reproducible and do not inherit personal bindings/options.
tmux -S "$socket" -f /dev/null new-session -d -s "$session" -x 120 -y 40

# Keep the pane inspectable if the command exits.
tmux -S "$socket" set-option -t "$session" remain-on-exit on
```

Run the TUI inside that pane. Prefer sending the literal command into the shell so the pane remains available for inspection:

```zsh
tmux -S "$socket" send-keys -t "$target" -l -- 'cd /path/to/project && npm run tui'
tmux -S "$socket" send-keys -t "$target" Enter
```

Adjust `/path/to/project && npm run tui` to the actual command under test.

## Observe the screen

After starting the TUI or sending input, wait briefly, then capture the visible pane:

```zsh
sleep 0.2
tmux -S "$socket" capture-pane -t "$target" -p -S 0 -E -
```

For more context, include scrollback:

```zsh
tmux -S "$socket" capture-pane -t "$target" -p -S -200 -E -
```

For layout-sensitive debugging, preserve trailing spaces:

```zsh
tmux -S "$socket" capture-pane -t "$target" -p -N -S 0 -E -
```

If a full-screen TUI appears stale or blank because it uses the alternate screen, explicitly capture the alternate screen:

```zsh
tmux -S "$socket" capture-pane -t "$target" -p -a -q -S 0 -E -
```

To inspect process and pane state:

```zsh
tmux -S "$socket" display-message -p -t "$target" 'cmd=#{pane_current_command} dead=#{pane_dead} exit=#{pane_dead_status} size=#{pane_width}x#{pane_height} cursor=#{cursor_x},#{cursor_y}'
tmux -S "$socket" list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} dead=#{pane_dead} size=#{pane_width}x#{pane_height}'
```

## Send keystrokes

Send special keys by name:

```zsh
tmux -S "$socket" send-keys -t "$target" Tab
tmux -S "$socket" send-keys -t "$target" Enter
tmux -S "$socket" send-keys -t "$target" Escape
tmux -S "$socket" send-keys -t "$target" Up Down Left Right
tmux -S "$socket" send-keys -t "$target" C-c
```

Send literal text with `-l`, then send `Enter` separately if needed:

```zsh
tmux -S "$socket" send-keys -t "$target" -l -- 'hello world'
tmux -S "$socket" send-keys -t "$target" Enter
```

For each interaction, use this loop:

1. Capture the current screen.
2. Send exactly the key or text needed.
3. Wait briefly for redraws or async work.
4. Capture again.
5. State what changed and whether it matches the expected behavior.

For picker UIs such as `fzf`, wait until a recognizable prompt appears before sending keystrokes. Capture the picker before interacting so the report can show what options were visible:

```zsh
until tmux -S "$socket" capture-pane -t "$target" -p -S 0 -E - | grep -q 'machine>'; do
  sleep 0.25
done
tmux -S "$socket" capture-pane -t "$target" -p -S 0 -E - > "$workdir/before-picker.txt"
tmux -S "$socket" send-keys -t "$target" -l -- 'mymain'
tmux -S "$socket" send-keys -t "$target" Enter
```

## Resize and test responsive layouts

Terminal dimensions affect many TUIs. Start with `120x40`, but also test common sizes when layout matters:

```zsh
tmux -S "$socket" resize-window -t "$session":0 -x 80 -y 24
tmux -S "$socket" capture-pane -t "$target" -p -S 0 -E -

tmux -S "$socket" resize-window -t "$session":0 -x 120 -y 40
tmux -S "$socket" capture-pane -t "$target" -p -S 0 -E -
```

## Record evidence

When investigating a bug, save captures and logs in the temporary work directory:

```zsh
tmux -S "$socket" capture-pane -t "$target" -p -S - > "$workdir/final-pane.txt"
tmux -S "$socket" pipe-pane -o -t "$target" "cat > '$workdir/pane-output.log'"
```

If the app has its own debug logging, enable it deliberately and record where the log goes. Do not add environment fallbacks that hide failures; if a required variable or path is missing, surface that explicitly.

## Scripted test harnesses

For repeatable tests, put the scenario in a temporary script and launch that script inside tmux. Use a sentinel file in `$workdir` to communicate completion status back to the outer agent process; `pane_dead_status` is not enough when the command returns to an interactive shell.

```zsh
cat > "$workdir/test.zsh" <<'EOF'
#!/usr/bin/env zsh
set -e -o pipefail

on_exit() {
  exit_code=$?
  print -r -- "$exit_code" > "$WORKDIR/test.rc"
}
trap on_exit EXIT

# run test steps here
EOF
chmod +x "$workdir/test.zsh"

tmux -S "$socket" send-keys -t "$target" -l -- "WORKDIR=$(printf %q "$workdir") zsh $(printf %q "$workdir/test.zsh")"
tmux -S "$socket" send-keys -t "$target" Enter
```

In zsh, avoid assigning to the special read-only parameter `status`; use a name such as `exit_code` or `rc` instead.

## Protect user state

If the TUI can modify user config, credentials, cache, history, databases, or project files, isolate those deliberately before launch. For example:

```zsh
mkdir -p "$workdir/home" "$workdir/xdg-config" "$workdir/xdg-cache" "$workdir/xdg-data"
home_q="$(printf %q "$workdir/home")"
config_q="$(printf %q "$workdir/xdg-config")"
cache_q="$(printf %q "$workdir/xdg-cache")"
data_q="$(printf %q "$workdir/xdg-data")"
cmd="cd /path/to/project && HOME=$home_q XDG_CONFIG_HOME=$config_q XDG_CACHE_HOME=$cache_q XDG_DATA_HOME=$data_q npm run tui"
tmux -S "$socket" send-keys -t "$target" -l -- "$cmd"
tmux -S "$socket" send-keys -t "$target" Enter
```

Only isolate `HOME`/XDG paths when that is compatible with the app under test; some tools intentionally need the real project or credentials.

## Multi-process TUIs

For apps that need a background server plus an interactive client, keep everything in the same isolated tmux server:

```zsh
tmux -S "$socket" new-window -t "$session" -n server
tmux -S "$socket" send-keys -t "$session:1.0" -l -- 'cd /path/to/project && npm run dev'
tmux -S "$socket" send-keys -t "$session:1.0" Enter

tmux -S "$socket" new-window -t "$session" -n client
tmux -S "$socket" send-keys -t "$session:2.0" -l -- 'cd /path/to/project && npm run tui'
tmux -S "$socket" send-keys -t "$session:2.0" Enter
```

Capture the relevant target pane by changing `target`, for example `target="$session:2.0"`.

## Remote and multi-machine tests

When testing a TUI/CLI that talks to remote machines, keep all test payloads in temporary directories on every machine and install cleanup traps before copying data:

```zsh
local_tmp="$(mktemp -d "${TMPDIR:-/tmp}/tui-test-local.XXXXXX")"
remote_tmp="$(ssh host 'mktemp -d "${TMPDIR:-/tmp}/tui-test-remote.XXXXXX"')"
cleanup() {
  rm -rf -- "$local_tmp"
  ssh host "rm -rf -- '$remote_tmp'"
}
trap cleanup EXIT
```

Preflight remote dependencies and routes before starting a long interactive run. For copy/sync tools, check both the local and remote commands they rely on (for example `rsync`) and, for remote-to-remote copies, check direct SSH/host-key readiness between the two remote machines. If the app intentionally needs the user's real SSH config, keys, or machine inventory, do not isolate `HOME`; instead explicitly state that only test payload directories are isolated.

When a machine lacks a required dependency or route, record it as a finding or skipped case rather than working around it in the test. Example: if a target lacks `rsync`, a copy tool based on rsync cannot be validated for that target until the dependency is installed.

## Cleanup

When done and no further inspection is needed:

```zsh
tmux -S "$socket" kill-server
rm -rf "$workdir"
```

If you find a failure that the user may want to inspect manually, do not clean up immediately. Report the socket and session so they can attach:

```zsh
tmux -S "$socket" attach -t "$session"
```

## Reporting results

When summarizing TUI testing, include:

- The exact command under test and working directory.
- The isolated tmux socket path and whether it was cleaned up.
- Terminal size(s) tested.
- Keystroke sequence used.
- Key screen captures or concise excerpts.
- Any exit status from `pane_dead_status` if the pane exited.
- Whether user/project state was isolated or intentionally left real.
- Any preflight failures, missing remote dependencies, or skipped machine pairs.

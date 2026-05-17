---
name: tmux-user-window
description: Send a command to the user's terminal (an adjacent tmux window in the agent's current tmux session) so the command runs in the user's shell instead of via the agent. Use when launching long-running foreground processes the user should watch and stop themselves — dev servers, tunnels (AppGarden, ngrok, ssh -L), watchers (vite, jest --watch), TUIs, REPLs.
---

# tmux-user-window

Some commands belong in the user's terminal, not in the agent's Bash tool. When the agent is running inside a tmux session and the user keeps their own shell open in an *adjacent window of the same session*, this skill is how you put a command into that shell.

## When to use this skill

- A long-running blocking process the user should monitor and stop with Ctrl-C — dev servers, build watchers, tunnels, TUIs, REPLs.
- A command whose output the user wants to see live, not piped back through the agent.
- A command that requires interactivity the agent can't provide — passwords, prompts, scrollback the user wants to keep.

## When NOT to use this skill

- Normal commands the agent should run itself — use the Bash tool.
- Tests or TUI inspection — use the `tui-tmux-testing` skill, which spins up an isolated tmux server on a temporary socket so it cannot disturb the user's session.
- Commands targeting remote machines — SSH and run them directly.
- Commands that silently change the user's shell state (`cd`, `export`, `unset`, `alias`, `source`, `eval`, `set`) unless the user asked for that exact effect.

## Discover the layout

The agent is inside one tmux window. Discover the others:

```zsh
tmux display-message -p '#{session_name}'
tmux list-windows -F '#{window_index}: #{window_name} active=#{window_active} panes=#{window_panes}'
```

Conventionally the agent's own window is the one with `active=1` (Claude Code itself is running there). The other window(s) are the user's terminals. If there are several non-active windows, ask the user which one to target — names like `zsh`, `bash`, `term`, or the project name are usually the user's; `claude` or `agent` is usually not.

If you're unsure whether you're even inside tmux, check `$TMUX` — if empty, this skill does not apply.

## Send the command

Always confirm the exact command and target window with the user *before* sending — `tmux send-keys` types directly into a live shell.

```zsh
tmux send-keys -t <session>:<window> -l -- "<command>"
tmux send-keys -t <session>:<window> Enter
```

The `-l` flag sends literal text — safer when the command contains quotes, backticks, or `$`. The `--` ends option parsing so a command starting with `-` isn't misread as a flag. Sending `Enter` as a separate call makes it visually clear that you are choosing to execute.

When there is only one session, you can target by window index alone:

```zsh
tmux send-keys -t 1 -l -- "appgarden tunnel open --serve ./slides.html"
tmux send-keys -t 1 Enter
```

For commands you're confident about, one call is fine:

```zsh
tmux send-keys -t 1 "appgarden tunnel open --serve ./slides.html" Enter
```

## Confirm before sending

Before calling `send-keys`, state to the user:

1. **Which window** you will send to (index + name, e.g. *"window 1 (zsh)"*).
2. **The exact command**, verbatim.
3. **Whether Enter will be appended** — i.e. whether the command will execute immediately or just land in the prompt for the user to inspect and run.

For risky commands (anything that mutates state, exposes a service publicly, deletes files, force-pushes, etc.), prefer sending the command **without** Enter so the user can review what landed and press Enter themselves.

## Verify what landed

Optional but useful, especially when debugging quoting or when you want to confirm the command actually started:

```zsh
sleep 0.2
tmux capture-pane -t <session>:<window> -p -S -20 -E -
```

This prints the last 20 lines of the target pane. Use a larger negative `-S` value (e.g. `-S -200`) to include more scrollback.

## Safety rules

- **Never interrupt the user's foreground work.** If the target window already has a running process (TUI, REPL, vim, less), keystrokes will be interpreted by *that* process, not the shell. Surface this and ask before sending.
- **Never send signals (`C-c`, `C-d`, `C-z`) to the user's window without explicit instruction.** They might be in the middle of something.
- **Avoid silent shell-state mutations** (`cd`, `export`, `unset`, `alias`, `source`, `eval`, `set`) unless the user asked for that specific effect — these change behavior of all subsequent commands in their session.
- **Don't chain `&& exit`, `; exit`, or background with `&`.** Let the user own the process lifecycle.
- **Don't send credentials or secrets as literal arguments.** Prefer commands that read from files, keychains, or env vars already set in the user's shell.
- **Don't use this to escalate.** If a command needs `sudo` and the user's terminal is logged in interactively as them, that's fine — but don't reach for this skill to bypass a permission prompt the agent's own tool gave you.

## Why not just run it in the agent's Bash?

Blocking foreground processes are a poor fit for the agent's Bash tool:

- `run_in_background: true` works for log-able tasks the agent will reattach to, but the user cannot directly Ctrl-C them, and the process is tied to the agent's lifecycle.
- Output piped back to the agent burns context and is hard to follow live.
- Some processes (tunnels, dev servers) are *meant* to be visible and interactive — the user's tmux pane is the right place for them.

By contrast, the user's tmux window is theirs: the process survives agent restarts, the user sees output as it happens, and Ctrl-C does the obvious thing.

## Worked example: AppGarden tunnel

The motivating case for this skill. The agent has produced an HTML file and wants the user to view it through a public tunnel:

```zsh
# 1. Discover.
tmux list-windows -F '#{window_index}: #{window_name} active=#{window_active}'
# 0: claude active=1
# 1: zsh active=0
# → user's terminal is window 1.

# 2. Confirm with the user: "I'll send `appgarden tunnel open --serve …` to window 1 (zsh) and press Enter. OK?"

# 3. Send.
tmux send-keys -t 1 -l -- "appgarden tunnel open --serve /abs/path/to/file.html"
tmux send-keys -t 1 Enter

# 4. (Optional) verify.
sleep 1
tmux capture-pane -t 1 -p -S -20 -E -
```

The tunnel blocks in window 1 until the user Ctrl-Cs it.

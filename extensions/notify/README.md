# notify

Runs shell commands on `agent_end`.

## Command sources (merged in this order)

1. Global hooks file: `~/.pi/agent/agent_end_hooks.txt`
2. Project hooks file: `.pi/agent_end_hooks.txt` (relative to current repo)
3. Env var: `PI_AGENT_END_HOOKS` (newline-separated commands)

Empty lines and `# comments` are ignored.

Commands are executed sequentially with:

```bash
bash -lc "<command>"
```

If a command fails, a warning notification is shown in Pi.

# hooks

Runs shell commands on Pi lifecycle events — a Claude Code / Codex–style hooks
system. Each hook receives the event as JSON on **stdin** plus a set of `PI_*`
environment variables, and can optionally **block or modify** the event.

## Config

Hooks are defined in `hooks.json`, merged from two locations (global first, then
project — both run):

1. Global: `~/.pi/agent/hooks.json`
2. Project: `.pi/hooks.json` (relative to the current repo)

```json
{
  "hooks": {
    "agent_end": [
      { "command": "~/.mybin/__cc_notify_done" }
    ],
    "tool_call": [
      {
        "matcher": "bash",
        "command": "~/.mybin/guard-bash",
        "blocking": true
      }
    ]
  }
}
```

### Hook entry fields

| Field | Required | Meaning |
|-------|----------|---------|
| `command` | yes | Shell command, run via `bash -lc`. |
| `matcher` | no | Regex tested against the tool name. Only meaningful for `tool_call` / `tool_result`; omit to match all. |
| `blocking` | no (default `false`) | If `true`, the agent **waits** for the command and honors its decision (see below). If `false`, the command is fire-and-forget and only its failures are logged. |

Multiple hooks for one event run in array order; the first one that blocks or
cancels short-circuits the rest.

## Supported events

Observe-only (fire-and-forget; `blocking: true` just makes the agent wait for
completion):

- `session_start`, `session_shutdown`
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `user_bash`
- `session_compact`

Blockable / mutable (only when `blocking: true`):

| Event | A blocking hook can… | How |
|-------|----------------------|-----|
| `tool_call` | block the tool call | exit non-zero, **or** print `{"block": true, "reason": "…"}` |
| `tool_result` | rewrite the result | print `{"content": [...], "isError": bool, "details": …}` |
| `before_agent_start` | replace the system prompt | print `{"systemPrompt": "…"}` |
| `session_before_compact` | cancel compaction | exit non-zero, **or** print `{"cancel": true}` |

For blockable events the hook's decision is read from **stdout JSON** when
present, otherwise from the **exit code** (non-zero = block/cancel).

## Payload (stdin)

Every command receives a JSON object on stdin, e.g. for `tool_call`:

```json
{ "event": "tool_call", "cwd": "/path/to/repo", "toolName": "bash", "input": { "command": "…" } }
```

`event` and `cwd` are always present; the remaining fields vary per event.

## Environment variables

Every command also runs with these set (alongside the inherited environment):

| Var | Value |
|-----|-------|
| `PI_EVENT` | event name (e.g. `tool_call`) |
| `PI_CWD` | current working directory |
| `PI_SESSION_ID` | current session id |
| `PI_SESSION_FILE` | session file path (if any) |
| `PI_SESSION_DIR` | session directory |
| `PI_SESSION_NAME` | session name (if set) |
| `PI_LEAF_ID` | current leaf entry id (if any) |
| `PI_MODEL` | active model id (if any) |
| `PI_TOOL_NAME` | tool name (`tool_call` / `tool_result` only) |

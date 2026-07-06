---
name: self-compact
description: Self-compact your own context as a sesh-managed agent — write a handover prompt to a tmp file, then fire ONE detached shell command that sends /compact to your own thread followed by the handover. Use when your context window is filling up mid-task (auto-compact looming), when the user says "self-compact" / "compactify yourself" / "compact and continue", or before starting a large new phase of work with a bloated context.
---

# self-compact

You are running out of context mid-task. Instead of letting auto-compact fire a generic
summary at an arbitrary moment, take control: write your own handover prompt, trigger
`/compact` deliberately, and re-anchor yourself with that handover the moment compaction
finishes.

This works because you are a sesh-managed agent living in a tmux pane, and `sesh thread
send` can type into *your own* pane. A runner process — owned by the tmux server, so no
agent harness can kill it — waits for your current turn to end, sends `/compact`, waits
for compaction to finish, then sends your handover — which arrives as the first user
message in your fresh, compacted context.

## When to use / not use

- **Use** when context is genuinely filling up (auto-compact warning visible, or you're
  deep into a long task and about to start another big phase).
- **Don't use** on a small session — claude refuses with "not enough messages", pi with
  `Nothing to compact (session too small)` (it keeps the most recent ~20k tokens, so
  anything smaller is uncompactable). If you're small enough to hit these, you didn't
  need to compact. (Harmless if you do: the error is loud in the pane and the handover
  still arrives and runs as a normal prompt.)
- **Doesn't apply** to headless threads (no pane — `sesh thread send` 409s) or outside
  sesh entirely. Precondition check below.

## Protocol

### 1. Resolve your own thread id

```zsh
TID=$(sesh info --json | jq -r '.thread.id')
```

`sesh info` infers the current thread from the calling pane's marker (more reliable than
`$SESH_THREAD_ID`, which is frozen at launch and can drift after adopt/reparent). If it
errors, you are **not in a sesh thread** — stop and tell the user this skill can't work
here. Also check `sesh info --json | jq -r '.head'` is `headful` if in doubt.

### 2. Write the handover prompt to a tmp file

Write `/tmp/self-compact-<first-8-of-TID>.md` **with your file-write tool** (not shell
`echo`/heredoc interpolation). It arrives as a user message addressed to you-after-
compaction, so write it as the continuation instructions you'd want to receive:

- **Task & goal** — what you are doing and why; the original user request.
- **State** — what's done, what's verified, what's uncommitted/in-flight.
- **Next steps** — the exact ordered list of what to do next.
- **Hard-won specifics** — file paths, thread/ticket ids, branch names, commands,
  URLs; decisions made and *why*; gotchas discovered that you'd otherwise re-derive.
- **Pointers** — files/notes to re-read to rebuild detail (cheaper than inlining them).

The compact summary will also exist, but treat the handover as the authoritative
continuation prompt — put everything you'd be sad to lose in it.

### 3. Write the runner script

Write `/tmp/self-compact-<tid8>.sh` **with your file-write tool**, baking in the real
values (the tmux server won't inherit your shell's variables — and the values are a
UUID and paths you chose, never externally-derived strings):

```sh
#!/bin/sh
# self-compact runner for thread <full-thread-uuid> — fired via `tmux run-shell -b`.
# Always exit 0: a nonzero exit makes tmux overlay the agent's pane with an error
# view that eats keystrokes; the log is the diagnostic channel.
exec > /tmp/self-compact-<tid8>.log 2>&1
TID=<full-thread-uuid>
HANDOVER=/tmp/self-compact-<tid8>.md
sesh await "$TID" --timeout 15m || exit 0
sesh thread send --id "$TID" --text "/compact" || exit 0
sleep 8
sesh await "$TID" --timeout 30m || exit 0
sesh thread send --id "$TID" --text "$(cat "$HANDOVER")"
exit 0
```

### 4. Fire it — your LAST tool call

```zsh
tmux run-shell -b "sh /tmp/self-compact-<tid8>.sh"
```

`run-shell -b` returns instantly and runs the script as a child of the **tmux server**,
completely outside your harness's process tree. This is load-bearing: codex kills the
process group of a tool call when the turn ends, so a `nohup …/& disown` runner dies
silently there (verified — empty log, no `/compact` ever arrived); claude and pi don't
kill it, but the tmux server is safe for all three, and tmux is guaranteed present (it
is the substrate sesh runs you on). The server's environment resolves `sesh` and the
daemon normally (verified). Do **not** use your harness's background-task mechanism
either: its completion notification would land as noise in your fresh post-compaction
context.

Why each piece:

- **First `await`** — blocks until *your own current turn ends*, so `/compact` lands on
  an idle pane. Load-bearing for pi: its harness `compact()` throws `busy` if the agent
  is mid-turn. (claude/codex would merely queue it, but idle-first is right for all.)
- **`sleep 8`** — compaction must be *visibly running* before the second `await`, which
  polls the daemon's cached mesh view (300ms probe tick, ~1s to confirm busy) and
  returns immediately on idle. Without the sleep it could fire on a stale idle reading.
- **Second `await`** — compaction shows as `busy` (the spinner animates the pane);
  idle again = compaction done. 30m is generous headroom for huge contexts.
- **Send `$(cat "$HANDOVER")`** — multi-line text goes through tmux bracketed paste, so
  the markdown arrives intact as one message. Command substitution output is passed as
  a single argv to `sesh` and never re-parsed by the shell, so arbitrary handover
  content (backticks, `$()`) is safe. The tmp file exists to dodge the nested-quoting
  swamp, not just for tidiness.
- **The log file** — every step's output lands there; it is the place to look when no
  handover arrives.

**Race backstop (verified on all three agents):** if timing slips and the handover lands
*during* compaction, all three agents queue it and auto-submit when compaction ends —
claude ("Press up to edit queued messages"), pi ("Queued message for after compaction"),
codex ("Messages to be submitted at end of turn"). The protocol degrades gracefully.

### 5. End your turn immediately

After firing the command, output one short line (e.g. "Self-compacting — handover will
arrive after compaction.") and **stop — no more tool calls**. The detached process is
waiting for exactly that. Anything else you do stretches the window and delays the
handoff.

### 6. On the receiving side (you, post-compaction)

The handover arrives as a user message on top of your compacted context. Treat it as
authoritative: re-read what it points to, then continue the task. Clean up
`/tmp/self-compact-<tid8>.{md,sh,log}` when convenient.

## Troubleshooting

- **No handover after ~10 min** (allow for a long compaction): the user (or a
  supervisor thread) should read `/tmp/self-compact-<tid8>.log`. `await: still busy
  after 15m` means the turn never ended in time; a 409 on `send` means the pane died.
- **`/compact` errored in the pane** (session too small — see above): the handover
  still arrives and runs; nothing is lost except the compaction itself.
- **Supervising from outside**: `sesh thread capture --id <tid>` shows the pane live;
  `sesh await <tid>` blocks until the turn/compaction finishes.

## Verified behavior (2026-07-06, sesh schema 38)

End-to-end tested on disposable threads for all three agent kinds — `/compact` via
`sesh thread send`, compaction reading as `busy`, mid-compaction sends queuing and
auto-submitting, delivery of a multi-line handover, and agents running this skill on
themselves (codeword survived compaction and the post-compaction step executed):

| agent | tested version | notes |
|---|---|---|
| claude | 2.1.201 | queues input even mid-turn; compaction ~1 min on a small session |
| pi | current | `compact()` hard-requires idle; compacted a 75k-token session, queued mid-compaction send ran after |
| codex | 0.142.5 | same queue shape, BUT kills detached process groups at turn end — a `nohup`/`disown` runner dies silently; the `tmux run-shell -b` runner is why this skill works on codex |

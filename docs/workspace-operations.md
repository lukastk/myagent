# Workspace and machine operations

On-demand reference extracted from the repository guide on 2026-10-07.
Paths in code spans are repository-root-relative unless explicitly qualified;
example paths and installed-home paths are not checkout files.
Dated incidents and validation results are historical observations, not a claim
about every currently installed runtime. Read only for the relevant task.

## Anti-pattern: never hand-create folders in `~/dev` (it is boxyard-managed)

`~/dev` is **boxyard's** managed box area (`user_boxes_path`). Every folder there is a
boxyard **box** named `<date>_<subid>__<name>` with metadata stored centrally in
`~/.boxyard`.

**Do NOT** create a folder directly in `~/dev` — e.g. `git worktree add ~/dev/my-feature`
or `mkdir ~/dev/scratch`. Such a folder is not boxyard-compliant (no metadata, wrong name),
so boxyard can't see or manage it and it pollutes the yard.

**Do this instead** — create work folders through the boxyard CLI:
- New empty / cloned box: `boxyard new -n <name> [--git-clone <url>] [-g <group>]`.
- Adopt an EXISTING folder: move it **out of `~/dev`** into a tmp dir first, then
  `boxyard new --from <tmpdir> -n <name> [-g <group>]` (takes it in as a compliant box;
  `--copy` to copy rather than move, `--no-initialise-git` for a plain snapshot).
- Need an isolated checkout for parallel work (e.g. a git worktree)? Put it **outside**
  `~/dev` (e.g. under `~/tmp` or the repo's own `.worktrees/`), or make it a boxyard box —
  but never `git worktree add` into `~/dev`.

(Recorded after an agent created plain `git worktree add` folders under `~/dev`, which were
not boxyard boxes and had to be moved out and re-imported via `boxyard new --from`.)

## SSHing into my machines

To ssh into one of my machines (or run a command on one), **prefer
`ssh-target <machine> [args...]`** — the canonical path. It looks the machine up
in the `MYRIG_MACHINES` zsh array (`macbook`, `macstudio`, `mymain`, `termux`,
`ideapad`, `pocket4`) and connects with the right user/host/port, plus connection multiplexing, a fast
`ConnectTimeout`, and `StrictHostKeyChecking=accept-new`. Run `ssh-target` with
no args to list the machines.

Per-machine shortcuts also exist (convenience, no multiplexing/timeout): `sm`
(macbook), `sr` (mymain, routes via `hcloud`), `sa` (`android-main -p 8022`),
plus `ssh-macstudio`, `ssh-mymain-root`, `ssh-kindle`. Pickers: `tssh [machine]`
(Tailscale fzf picker) and `hssh [user@][context:]server` (Hetzner cloud boxes).

Non-interactive ssh doesn't load login-shell functions — to call one (e.g.
`myrig-reinstall-home`) prepend `source ~/.myrig/utils.sh &&`.

For the full machine inventory, the desktop-enabled `mymain` box, **mycockpit** (the
cross-machine tmux cockpit), and the rest of my setup/tooling, **use the `mysetup-navigator`
skill** (its "SSHing into the machines" section is the source of truth here).

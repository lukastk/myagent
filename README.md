# myagent

Personal coding-agent extensions, skills, MCP servers, and configuration for
[Pi](https://github.com/badlogic/pi-mono), Claude Code, and Codex.

## Setup

```bash
# Install Pi globally
npm install -g @earendil-works/pi-coding-agent

# Install local + external extensions/skills and MCP servers for Pi, Claude,
# and Codex
./install.sh

# Also remove extensions/skills that are no longer declared
./install.sh --prune
```

`install.sh` does all of the following:

- Symlinks local extensions from `extensions/` into `~/.pi/agent/extensions/`
- Symlinks local skills from `skills/` into `~/.agents/skills/`
- Installs external extensions listed in `external_extensions.txt` via `pi install`
- Installs external skills listed in `external_skills.txt` via `npx skills add <source> -g -y`
- Applies `mcp.json` to Pi, Claude Code, and Codex
- Symlinks `models.json` (custom Pi providers/models) into `~/.pi/agent/models.json`
- With `--prune`, removes stale local symlinks and uninstalls previously managed external entries that are no longer listed

Use `--pi-only`, `--claude-only`, or `--codex-only` to apply only one agent
surface. Restart/reload the relevant client after installation.

## Playwright browsers

myagent exposes four Playwright MCP servers. All use the ordinary upstream
Playwright browser tools; the server name chooses where and how Brave runs.

| MCP server | Browser | Intended use |
|---|---|---|
| `playwright` | A lazy, isolated Brave on the agent's current machine | Default local browsing |
| `playwright-main` | The user's real interactive Brave on local `:9222` | Work the user should watch live |
| `playwright-macstudio` | A lazy, isolated Brave on Mac Studio over SSH | Default remote acquisition worker |
| `playwright-macbook` | A lazy, isolated Brave on MacBook over SSH | Opt-in laptop worker; may be asleep/offline |

The remote servers are deliberately non-direct in Pi: select/promote the one
you need through `/mcp`, then use its normal `browser_*` tools. Claude Code and
Codex expose the same tools under the corresponding MCP server namespace. A
plain-language agent instruction is enough, for example: “Use
`playwright-macstudio` to inspect this page.”

### Remote worker setup

Run `./install.sh` on both the client and each target Mac. The client must be
able to run `ssh-target macstudio` / `ssh-target macbook`. A target must have:

- Brave launched at least once, with its real profile in the normal macOS path;
- myagent's patched Playwright MCP install under `~/.local/playwright-mcp`;
- an active macOS GUI launchd domain;
- the existing passwordless `launchctl asuser` bridge used by the isolated
  Brave launcher to reach the user's keychain.

The target-side readiness gate checks all of these before MCP startup and gives
a specific stderr error for an offline, unprepared, or incompatible target.
Only `macstudio` and `macbook` are accepted; arbitrary SSH hosts and commands
cannot be supplied.

### Security and lifecycle

Remote MCP stdio is carried through the existing Tailscale + SSH trust path. No
new port or unauthenticated service is exposed. Playwright, Brave, the seeded
profile, cookies, keychain access, downloads, and output files remain on the
target; normal MCP results and screenshots cross back over SSH.

Each SSH channel passes its unique remote command-shell PID as the validated
target-local profile owner. It must be canonical decimal text (at least 2, with
no leading zero), is string-matched to the target process, and is then checked
with `kill -0`; caller text is never evaluated as shell arithmetic. This matters
because multiplexed SSH channels share an sshd parent and would otherwise
collide. Stdio EOF closes Playwright and Brave on normal disconnect. After a
hard failure, the next launcher kills any orphan whose numeric owner PID is no
longer alive and removes its profile; target `/tmp` cleanup and reboot are final
backstops.

## Adding extensions

- **Local extension:** create `extensions/<name>/index.ts`, then run `./install.sh`.
- **External extension:** add a line to `external_extensions.txt`, then run `./install.sh`.

## Adding skills

- **Local skill:** create `skills/<name>/SKILL.md`, then run `./install.sh`.
- **External skill:** add a line to `external_skills.txt`, then run `./install.sh`.

For full details and examples, see [AGENTS.md](AGENTS.md).

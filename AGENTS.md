# myagent

Personal coding-agent extensions, skills, MCP servers and configuration for
Pi, Claude Code and Codex. This is the concise operating guide; load only the
task-relevant references below, not the whole documentation set.

## Ownership and map

- `extensions/<name>/index.ts`: local Pi extensions; each folder's README or
  source header documents its contract. **`extensions/sesh-agent-state` is a
  symlink into `../sesh/integrations/pi/sesh-agent-state`: edit it in sesh,
  not here.** The Claude lifecycle hooks belong to myrig.
- `skills/`: locally authored skills. `external_skills.txt`: upstream and
  sibling-repo skills, installed from GitHub as **copies**, not live links to
  sibling checkouts. Edit those at their source; distribution requires a push
  and reinstall, not editing installed copies.
- `external_extensions.txt` (+ `external_extensions_mac.txt` on macOS):
  sole declaration of installed external extensions.
- `pi_settings.json`: declarative overlay onto Pi's mutable settings;
  `models.json`: read-only custom-provider snapshot, symlinked into Pi.
- `mcp.json`: shared MCP declarations for all three clients.
  `scripts/brave-cdp/`: browser launchers, lazy shim and SSH transport.
- `install.sh`: orchestrates `scripts/install-pi.sh`,
  `scripts/install-claude.sh`, then `scripts/install-codex.sh`.
  `scripts/` also holds targeted tests; `_dev/experiments/` holds R&D.
- `docs/`: on-demand guides. `CLAUDE.md` imports only this core and
  `AGENTS.local.md`; the agents-local extension loads local memory into Pi.
  Keep that memory private/uncommitted, concise and historically qualified.
  Never replace trimmed context with eager imports of the long references.

## Commands and checks

- Development: `pi -e ./extensions/<name>/`; read the installed Pi docs and
  relevant extension examples before implementing API changes.
- Installation (changes live clients): `./install.sh`; select a surface with
  `--pi-only`, `--claude-only` or `--codex-only`. After an intended install,
  Pi supports `/reload`; restart Claude/Codex clients. Do not interrupt others.
- `./install.sh --prune` removes undeclared external extensions, including
  orphans and mac-only entries on Linux. Skills prune **only previously
  managed** entries: their global namespace is shared.
- Read-only context inventory: `python3 scripts/audit-context.py`
  (characters/4 estimates); `--installed` additionally checks shared wiring.
- Match tests to the change: `python3 scripts/test-install-pi-extensions.py`,
  `bash scripts/test-install-codex.sh`, or
  `bash scripts/brave-cdp/test-remote-playwright.sh`.
  MCP/host upgrades also require the integration checks in
  [Pi MCP codemode](docs/pi-mcp-codemode.md) and
  [context policy](docs/agent-context.md). Historical validation was on Pi
  0.99.1; check the actual runtime rather than assuming compatibility.
  Documentation-only work needs link/path, diff and eager-size checks, not
  browser launches or deployment.

## Mandatory invariants and traps

- Never hand-create folders/worktrees in `~/dev`: use `boxyard` via
  `boxyard-cli`, or put scratch/worktrees outside it. For machine operations
  use `mysetup-navigator` and canonical `ssh-target <machine>`.
- Agent shell calls use zsh: use argv arrays, not bash-style word splitting.
  Never interpolate external strings into code parsed by `sh -c`, eval or
  similar; pass separate argv. Installer cwd wrappers must remain safe.
- Keep Pi settings an overlay: do not symlink/copy over its runtime-owned
  settings, or add `packages` to `pi_settings.json`. Declare extensions only
  in the external-extension lists. Keep models symlinked, not merged.
  `shellPath` is machine-specific installer state; respect deliberate pins.
- One MCP connection owner: our `lukastk/pi-mcp-adapter` fork,
  `myagent-codemode` branch. Native MCP stays disabled via
  `extensions: ["-builtin:mcp"]`; the upstream npm adapter is mutually
  exclusive. Keep native `codemode` alongside ordinary tools
  (`defaultTools: ["+codemode"]`), and `scriptMode: false`.
- **All MCP servers use `directTools: "search"`**, including local Playwright.
  Deferred declarations save context; `lifecycle: "lazy"` and idle disconnect
  separately save processes. Keep `deferWithMissingMetadata: true`; explicitly
  connect only the needed cold server. Pi exposure is not a promise about
  Claude/Codex tool search. Do not raise Codex's instruction cap to hide bloat.
- The web research persona belongs only in search-provider requests, never
  the coding agent's system prompt. `web_search` and `fetch` are direct;
  alternative Puppeteer `browser` is deferred. Default browsing uses
  Playwright with Brave: discover with
  `mcp({ search: "browser", server: "playwright" })`; a cold catalog needs
  `mcp({ connect: "playwright" })`.
- **Close isolated browsers with `browser_close` when done; never close
  `playwright-main`**, which controls the user's real window. Preserve profile
  isolation, patched browser install, macOS keychain bridge, sandbox policy,
  lazy shim and real-window `:9222` gate. Read the browser guide before changes.
  Remote transport accepts only macstudio/macbook, fixed commands and validated
  live owner PIDs; keep `SSH_TARGET_NO_MUX=1`. Target downloads stay remote.
  Auth tokens/cookies are not repository content.
- Extension shortcuts: **`Ctrl+Shift+<letter>`, never `Ctrl+Alt`** (tmux
  folds Cmd/Super into Meta); avoid foot's `Ctrl+Shift+{c,v,r,n,o,u,x,z}`.
  Pi packages belong in `peerDependencies` with `"*"`.
- Keep `tuiMode: "fullscreen"` paired with
  `fullscreenExitOutput: "transcript"`: intentional tmux wheel support,
  with alt-screen/capture limitations documented in the settings guide.
- Fail loudly on unsupported configuration or install/update errors rather
  than silently dropping fields or hiding a broken setup.

## Task → reference

Read only the relevant row; these are ordinary links, not eager imports.

| Task | Reference |
|---|---|
| Install/update/prune; settings, models, fullscreen or shell defaults | [Installation and settings](docs/installation-and-settings.md) |
| Extension ownership, authoring, APIs, events, dependencies, shortcuts | [Extension development](docs/extension-development.md), then the extension's README/source |
| Skill frontmatter, manual-only discovery, sibling-repo distribution | [Skill development](docs/skill-development.md) |
| MCP discovery/OAuth; isolated/live/remote Brave; keychain, shim, GC, incident history | [MCP and browsers](docs/mcp-and-browsers.md) |
| Adapter fork/native codemode ownership, upgrades and integration tests | [Pi MCP codemode](docs/pi-mcp-codemode.md) |
| Eager context, shared instruction ownership, exposure policy and audit | [Agent context](docs/agent-context.md) |
| Box adoption, SSH shortcuts, machine-operation background | [Workspace operations](docs/workspace-operations.md), plus the relevant global skill |

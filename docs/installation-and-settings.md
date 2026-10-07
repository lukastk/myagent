# Installation and Pi settings

On-demand reference extracted from the repository guide on 2026-10-07.
Paths in code spans are repository-root-relative unless explicitly qualified;
example paths and installed-home paths are not checkout files.
Dated incidents and validation results are historical observations, not a claim
about every currently installed runtime. Read only for the relevant task.

## Repo structure

```
myagent/
├── AGENTS.md               # Concise operating guide (CLAUDE.md imports it and private local memory)
├── install.sh              # Orchestrator — runs the Pi, Claude, and Codex installers
├── external_extensions.txt     # External extensions to install via `pi install`
├── external_extensions_mac.txt # macOS-only external extensions
├── external_skills.txt         # External skills to install via `npx skills add`
├── pi_settings.json        # Declarative Pi settings, shallow-merged onto ~/.pi/agent/settings.json
├── mcp.json                # MCP server definitions applied to Pi, Claude, and Codex
├── models.json             # Custom Pi providers/models (Venice, abliteration.ai), symlinked to ~/.pi/agent/models.json
├── scripts/
│   ├── install-pi.sh                  # Pi-side install (extensions, skills, mcp.json symlinks)
│   ├── install-claude.sh              # Claude Code install (skill symlinks + `claude mcp add-json`)
│   ├── install-codex.sh               # Codex MCP install/prune via `codex mcp`
│   ├── configure-pi-tool-binaries.sh
│   └── brave-cdp/
│       ├── brave-cdp-mcp              # Per-agent isolated-Brave launcher for the playwright MCP server
│       ├── remote-playwright-mcp      # Allow-listed SSH stdio client transport
│       └── remote-playwright-host     # Target-Mac readiness/keychain gate
├── extensions/             # Local extensions (each is a folder)
│   └── <name>/
│       ├── index.ts        # Extension entry point (default export)
│       └── package.json    # Optional, only if the extension has npm dependencies
└── skills/                 # Local skills (each is a folder with SKILL.md)
    └── <name>/
        ├── SKILL.md        # Skill frontmatter + instructions
        └── ...             # Optional scripts/references/assets
```

## How install.sh works

`./install.sh` runs `scripts/install-pi.sh`, `scripts/install-claude.sh`, then
`scripts/install-codex.sh`. Pass `--prune` to all three. Pass `--pi-only`,
`--claude-only`, or `--codex-only` to run one surface.

**`scripts/install-pi.sh`** — Pi-side:
1. Symlinks each folder under `extensions/` into `~/.pi/agent/extensions/` so Pi auto-discovers them.
2. Runs `npm install --omit=dev` for extensions with `package.json`; web goes through `scripts/install-web-dependencies.sh` for Android's native Sharp/libvips build and a real image probe on every platform. See [web dependency setup](../extensions/web/README.md#termux--android-native-image-support).
3. Symlinks each folder under `skills/` into `~/.agents/skills/` so Pi can discover local skills.
4. Runs `npm install --omit=dev` for any skill that has a `package.json`.
5. Shallow-merges `pi_settings.json` onto `~/.pi/agent/settings.json` (our keys win, runtime keys preserved — see "Pi settings" below).
6. Symlinks `mcp.json` to `~/.config/mcp/mcp.json`, `~/.pi/agent/mcp-adapter.json`, and `~/.pi/agent/mcp.json` (the last is for explicit native CLI diagnostics; native session MCP is disabled).
   Then symlinks `models.json` to `~/.pi/agent/models.json` (a regular file already there is backed up to `models.json.stale-<epoch>.bak` and adopted). Symlink, not merge: Pi never writes `models.json` and re-reads it every time `/model` opens — see "Custom models" below.
7. Runs `scripts/configure-pi-tool-binaries.sh` to configure Pi tool binaries.
8. Installs Playwright MCP (patched): persistently installs `@playwright/mcp` into `~/.local/playwright-mcp` and applies three patches — a `Browser.setDownloadBehavior` skip (all platforms, for the CDP-connect/opt-out path), a Chromium-switches patch (**macOS only** — drop `--use-mock-keychain`/`--password-store=basic` so a Brave that Playwright *launches* can decrypt the seeded profile's cookies; Linux deliberately keeps `--password-store=basic` for its portable cookie key), and the `browser_close` tool description (all platforms; upstream ships "Close the page", which misled agents into thinking it only closes a tab and leaving the per-agent Brave resident all session; it actually disposes the whole browser process, so the patched text tells agents to close it when done). The installer locates each patch target by string search, since current playwright-core (≥1.61) bundles these into `lib/coreBundle.js` (formerly the separate `crBrowser.js` / `chromiumSwitches.js`). It symlinks `brave-cdp-mcp`, `mcp-lazy`, `mcp-lazy-shim`, `remote-playwright-mcp`, and `remote-playwright-host` next to that install, and warms the lazy-shim cache (`mcp-lazy-cache.json`) once so a non-browsing session skips the ~128 MB Node `cli.js` (see [Lazy MCP proxy shim](mcp-and-browsers.md#lazy-mcp-proxy-shim-mcp-lazy--mcp-lazy-shim)). The Playwright servers in `mcp.json` run those launchers.
9. Reads `external_extensions.txt` (+ `external_extensions_mac.txt` on macOS), deduplicates the platform-effective set, and calls `scripts/install-pi-extensions.sh`: `pi install --no-approve <source>` then `pi update --no-approve <source>` for each. Only declared sources update; pins stay pinned, git branches advance, Pi itself and project/unrelated packages are untouched. Failures stop the install. Our declared MCP fork is mutually exclusive with `npm:pi-mcp-adapter`; the helper removes the npm copy after successfully installing/updating the fork, even without `--prune`.
10. Reads `external_skills.txt` and runs `npx -y skills add <source> -g -y -a codex -a claude-code -a pi`. The explicit `-a` agent list (repeated per agent — a comma-joined value is parsed as one invalid name) stops the skills CLI's `-y` fast path from force-adding every skills-family agent, including project-only PromptScript, which would otherwise fail every global install.
11. With `--prune`, removes stale local symlinks and reconciles installed extensions/skills against what's declared:
    - **External extensions** are reconciled against the declared set (`external_extensions.txt`, plus `external_extensions_mac.txt` only on macOS): it iterates `pi list` (what Pi actually has) and `pi remove`s anything not declared — including orphans myagent never installed itself. This is *platform-strict*: a mac-only extension installed on Linux is removed there. There is intentionally no extension state file (a record of "what we installed" can't see orphans — that's how `pi-slopchop` survived a prior prune); the prune deletes the legacy `.install-state/external_extensions.txt` if present.
    - **External skills** still use the `.install-state/external_skills.txt` record and only remove skills myagent previously installed (global skills are a shared namespace, so reconcile-to-declared would be too aggressive).

After running install, reload Pi with `/reload` if it's running.

**`scripts/install-claude.sh`** — Claude Code side:
1. Symlinks each folder under `skills/` into `~/.claude/skills/` so Claude discovers local skills.
2. Symlinks each external skill (resolved via `~/.agents/skills/<name>`) into `~/.claude/skills/`.
3. For every server in `mcp.json`, runs `claude mcp remove <name> -s user` then `claude mcp add-json <name> ... -s user` (idempotent re-apply at user scope). Servers with a `cwd` field are wrapped as `sh -c "cd <cwd> && exec ..."` because `claude mcp add-json` silently drops `cwd`. `lifecycle` is Pi-specific and stripped.
4. With `--prune`, removes Claude skill symlinks and MCP servers it previously installed but are no longer listed.

Restart Claude Code to pick up new skills/MCP servers.

**`scripts/install-codex.sh`** — Codex side:
1. Reads every server from `mcp.json` and validates the full set before changing Codex config.
2. Re-applies stdio servers with `codex mcp remove/add`; like Claude, entries with `cwd` are safely wrapped in `sh -c "cd … && exec …"` because the installed `codex mcp add` command has no `cwd` flag.
3. Applies simple streamable-HTTP entries by URL and fails loudly rather than dropping unsupported static headers.
4. Records the server names it manages in `.install-state/codex_mcp.txt`; with `--prune`, removes previously managed names no longer declared.

Codex CLI, the Codex IDE extension, and the Codex desktop app share
`~/.codex/config.toml`. Restart Codex clients after install. Codex does not read
myagent's JSON MCP config on its own; this installer is the explicit bridge.

## Pi settings

`pi_settings.json` holds our declarative Pi settings (default provider/model,
thinking level, project trust, TUI mode, and `enabledModels`, which is also the
scope session-model cycles through). `install-pi.sh`
**shallow-merges** it onto the live `~/.pi/agent/settings.json` with
`jq -s '.[0] * .[1]'` (existing `*` ours): our declared keys overwrite, but any
key we don't declare is left untouched.

Why merge instead of symlink or copy: Pi *mutates* `settings.json` at runtime —
it owns `packages` (the installed-extension list), `lastChangelogVersion`, and
similar. A symlink would push that runtime churn back into this repo on every
launch; a wholesale copy would wipe it. The overlay keeps this file a clean,
minimal statement of desired settings while letting Pi manage its own state.

**`defaultTools: ["+codemode"]`** enables Pi's built-in JavaScript tool
orchestration (Pi >= 0.99.0) without replacing the existing tool selection.
The default `codemode.mode: "on"` keeps ordinary tools directly callable; we
do not force `"only"` mode. MCP belongs to our `lukastk/pi-mcp-adapter` fork
(`myagent-codemode` branch), with **`extensions: ["-builtin:mcp"]`** explicitly
disabling native MCP so there is exactly one connection owner. Native codemode
remains enabled. The fork retains lazy/idle lifecycle and bridges native tool
discovery, annotations, and structured results; see [Pi MCP codemode](pi-mcp-codemode.md).
The tested host is Pi 0.99.1; re-run the integration tests on future upgrades.
Native MCP 0.99.1 itself still connects enabled servers at startup and ignores
`lifecycle`/`directTools`.

**`tuiMode: "fullscreen"`** is declared here so the wheel scrolls Pi's transcript
inside tmux. It is the ONLY reason the setting is set. Pi's `regular` mode renders
inline on the normal screen and never asks the terminal for mouse tracking, so
inside mycockpit tmux keeps the wheel for itself and you land in copy-mode;
`fullscreen` takes the alternate screen and enables SGR mouse tracking
(`?1002h`+`?1006h`), which is exactly what Claude Code does and why Claude Code
alone used to scroll properly there. Verified 2026-08-23 by injecting real SGR
wheel events into a tmux client: the transcript scrolled in place and tmux did not
enter copy-mode. myrig's `AGENTS.md` carries the full cross-agent picture and the
matching tmux-side bindings for codex.

Two costs, both accepted deliberately. Pi upstream still labels fullscreen
**experimental** (its `/settings` → "TUI mode" entry says so), and while it runs
the transcript lives in the alt screen, so it is NOT in tmux's scrollback and
`capture-pane` sees only the visible screen — hence
**`fullscreenExitOutput: "transcript"`** alongside it, which prints the
conversation back into the terminal on exit instead of a bare resume hint. To
A/B the two modes without editing anything, use `/settings` → "TUI mode" in a
live session, or `pi --tui-mode regular`.

**`packages`** is deliberately **not** declared here: the installed-extension
list is owned by `external_extensions.txt` (+ the mac variant), applied via
`pi install` in the step above. Declaring it here too would recreate a
split-brain. (This split used to live across repos: myrig's
`home/.pi/agent/settings.json.jinja` once hardcoded `packages`, re-seeding
entries — e.g. `pi-slopchop` — that myagent had dropped. That template has been
removed; myagent is now the sole owner.) To add a package, edit
`external_extensions.txt` — not this file. To remove one, delete its line and run
`./install.sh --prune`: the prune reconciles `pi list` against the declared set,
so it now also evicts any orphan re-seeded by old tooling (the `pi-slopchop` case
above), not just entries myagent installed itself.

**`shellPath`** is *injected by install-pi.sh*, not stored in `pi_settings.json`,
because the correct path is machine-specific (`/bin/zsh` on mac, a
`/data/data/com.termux/...` path on termux). Pi does **not** auto-detect zsh —
with no `shellPath` its `getShellConfig()` goes straight to `/bin/bash`
(`dist/utils/shell.js`), which is the bug this setting exists to fix. So the
installer resolves the real zsh via `command -v zsh` and sets it, but only when
zsh exists and the live settings don't already pin a `shellPath` (so a
deliberate user choice is never overridden, and a zsh-less box is left to Pi's
own `/bin/bash` fallback rather than getting a broken path).

### Custom models (`models.json`)

`models.json` declares custom providers/models that Pi's built-in catalogs don't
carry — currently **Venice** (key from `$VENICE_API_KEY`) and **abliteration.ai**
(`$ABLITERATION_AI_API_KEY`). Their preferred models are listed in
`pi_settings.json`'s `enabledModels`; the previous abliteration.ai large model is
available in the full `/model` catalog but intentionally outside that preferred
scope. The abliteration.ai provider enables Pi's per-session affinity headers so
the service can route a conversation for prompt-cache reuse. This file is the
supported escape hatch (pi's `docs/models.md`) for anything Pi's catalogs lack:
Pi's OpenRouter catalog is a curated list served from pi.dev, not OpenRouter's
live model list. Unlike `settings.json` it is **symlinked**, not merged, to
`~/.pi/agent/models.json`: Pi treats it as a read-only snapshot and re-reads it
whenever `/model` opens, so repo edits take effect without restarting Pi.

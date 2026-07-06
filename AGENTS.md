# myagent

Personal Pi coding agent extensions, skills, and configuration.

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
in the `MYRIG_MACHINES` zsh array (`macbook`, `macstudio`, `mymain`, `termux`)
and connects with the right user/host/port, plus connection multiplexing, a fast
`ConnectTimeout`, and `StrictHostKeyChecking=accept-new`. Run `ssh-target` with
no args to list the machines.

Per-machine shortcuts also exist (convenience, no multiplexing/timeout): `sm`
(macbook), `sr` (mymain, routes via `hcloud`), `sa` (`android-main -p 8022`),
plus `ssh-macstudio`, `ssh-mymain-root`, `ssh-kindle`. Pickers: `tssh [machine]`
(Tailscale fzf picker) and `hssh [user@][context:]server` (Hetzner cloud boxes).

Non-interactive ssh doesn't load login-shell functions — to call one (e.g.
`myrig-reinstall-home`) prepend `source ~/.myrig/utils.sh &&`.

For the full machine inventory, the desktop-enabled `mymain` box, the cross-machine
tmux cockpit, and the rest of my setup/tooling, **use the `mysetup-navigator`
skill** (its "SSHing into the machines" section is the source of truth here).

## Repo structure

```
myagent/
├── AGENTS.md               # This file (CLAUDE.md is a stub that imports it via `@AGENTS.md`)
├── install.sh              # Orchestrator — runs scripts/install-pi.sh && scripts/install-claude.sh
├── external_extensions.txt     # External extensions to install via `pi install`
├── external_extensions_mac.txt # macOS-only external extensions
├── external_skills.txt         # External skills to install via `npx skills add`
├── pi_settings.json        # Declarative Pi settings, shallow-merged onto ~/.pi/agent/settings.json
├── mcp.json                # MCP server definitions (symlinked to ~/.config/mcp/mcp.json; also applied to Claude)
├── scripts/
│   ├── install-pi.sh                  # Pi-side install (extensions, skills, mcp.json symlinks)
│   ├── install-claude.sh              # Claude Code install (skill symlinks + `claude mcp add-json`)
│   ├── configure-pi-tool-binaries.sh
│   └── brave-cdp/
│       └── brave-cdp-mcp              # Per-agent isolated-Brave launcher for the playwright MCP server
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

`./install.sh` runs `scripts/install-pi.sh` then `scripts/install-claude.sh`.
Pass `--prune` to forward it to both. Pass `--pi-only` or `--claude-only` to skip one.

**`scripts/install-pi.sh`** — Pi-side:
1. Symlinks each folder under `extensions/` into `~/.pi/agent/extensions/` so Pi auto-discovers them.
2. Runs `npm install --omit=dev` for any extension that has a `package.json`.
3. Symlinks each folder under `skills/` into `~/.agents/skills/` so Pi can discover local skills.
4. Runs `npm install --omit=dev` for any skill that has a `package.json`.
5. Shallow-merges `pi_settings.json` onto `~/.pi/agent/settings.json` (our keys win, runtime keys preserved — see "Pi settings" below).
6. Symlinks `mcp.json` to `~/.config/mcp/mcp.json` and `~/.pi/agent/mcp.json`.
7. Runs `scripts/configure-pi-tool-binaries.sh` to configure Pi tool binaries.
8. Installs Playwright MCP (patched): persistently installs `@playwright/mcp` into `~/.local/playwright-mcp` and applies three patches — a `Browser.setDownloadBehavior` skip (all platforms, for the CDP-connect/opt-out path), a Chromium-switches patch (**macOS only** — drop `--use-mock-keychain`/`--password-store=basic` so a Brave that Playwright *launches* can decrypt the seeded profile's cookies; skipped on Linux, where the launcher connects rather than launches), and the `browser_close` tool description (all platforms; upstream ships "Close the page", which misled agents into thinking it only closes a tab and leaving the per-agent Brave resident all session; it actually disposes the whole browser process, so the patched text tells agents to close it when done). The installer locates each patch target by string search, since current playwright-core (≥1.61) bundles these into `lib/coreBundle.js` (formerly the separate `crBrowser.js` / `chromiumSwitches.js`). Also symlinks the `brave-cdp-mcp` launcher (from `scripts/brave-cdp/`) next to that install. (The `playwright` server in `mcp.json` runs that launcher — see "Per-agent isolated Brave" below.)
9. Reads `external_extensions.txt` (+ `external_extensions_mac.txt` on macOS) and runs `pi install <source>`.
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

## Local extensions

The extensions that ship in this repo (each under `extensions/<name>/`; see the per-folder `README.md` / `index.ts` header for detail):

- **agents-local** — appends a project's `AGENTS.local.md` (personal, uncommitted notes) to the system prompt when one is found alongside `AGENTS.md`.
- **compact-tools** — compact tool-call rendering plus a keyboard-driven split-pane tool-output viewer (`README.md`).
- **hooks** — Claude Code / Codex–style lifecycle hooks: shell commands run on Pi events (from `hooks.json`), able to block or modify the event (`README.md`).
- **message-barrel** — save draft messages into a barrel and paste them back into the input editor later (`README.md`).
- **pi-hashline-edit** — replaces the built-in `read`/`edit` tools with a hash-anchored line-editing workflow that rejects stale edits (`README.md`).
- **privatemode** — registers PrivateMode AI (E2E-encrypted confidential computing) as an OpenAI-compatible provider, auto-starting its local podman proxy on demand.
- **session-model** — session-only model switching: `/smodel`, `/smodel-scope`, and cycle shortcuts.
- **web** — three tools — web search, URL fetch (with site-specific scrapers), and browser automation; transplanted from oh-my-pi (`README.md`).

## How to write a new extension

### 1. Create a folder

```
extensions/my-extension/index.ts
```

### 2. Write the extension

Every extension default-exports a function that receives the `ExtensionAPI` object:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, shortcuts, event handlers, etc.
}
```

The function can be async if you need to do setup work at load time.

### 3. Register tools, commands, or event handlers

**Custom tool:**

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "What the tool does (the model reads this)",
  parameters: Type.Object({
    input: Type.String({ description: "What this parameter is" }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Result: ${params.input}` }],
      details: {},
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

**Slash command:**

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("greet", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello, ${args || "world"}!`);
    },
  });
}
```

**Event handler:**

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\nAlways be concise.",
    };
  });
}
```

### 4. If you need npm dependencies

Add a `package.json` to your extension folder:

```json
{
  "name": "my-extension",
  "private": true,
  "type": "module",
  "dependencies": {
    "some-lib": "^1.0.0"
  }
}
```

Pi's own packages should go in `peerDependencies` with `"*"`:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  }
}
```

`install.sh` will run `npm install --omit=dev` automatically.

### 5. Test and iterate

During development, test with:

```bash
pi -e ./extensions/my-extension/
```

Once it works, run `./install.sh` to symlink it into place. Extensions in auto-discovered locations support hot reload via `/reload` in Pi.

## Available imports

| Package | What it provides |
|---------|-----------------|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `defineTool`, `isToolCallEventType`, `withFileMutationQueue`, `truncateHead`, `truncateTail` |
| `@earendil-works/pi-ai` | `Type` (re-export of typebox), `StringEnum` |
| `@sinclair/typebox` | `Type.Object`, `Type.String`, `Type.Optional`, `Type.Array`, etc. |
| `@earendil-works/pi-tui` | TUI components if building custom UI |

## Key extension API methods

- `pi.registerTool(def)` — register a tool the model can call
- `pi.registerCommand(name, def)` — register a `/name` slash command
- `pi.registerShortcut(key, def)` — register a keyboard shortcut
- `pi.on(event, handler)` — subscribe to lifecycle events
- `pi.registerProvider(name, config)` — register a custom LLM provider
- `pi.sendMessage(msg)` — inject a message into the session
- `pi.exec(cmd, args)` — run a shell command

## Key lifecycle events

- `session_start` — session loaded or reloaded
- `before_agent_start` — after user submits prompt, before agent loop (modify system prompt here)
- `tool_call` — before a tool executes (can block or mutate input)
- `tool_result` — after a tool executes (can modify output before model sees it)
- `context` — before each LLM call (can filter/modify messages)

## Adding an external extension

Add a line to `external_extensions.txt`:

```
npm:pi-hashline-edit
git:github.com/user/repo
```

Then run `./install.sh`.

### Platform-specific extensions

Extensions that only work on certain platforms go in platform-specific files:

- `external_extensions_mac.txt` — installed only on macOS

Same format as `external_extensions.txt`. Add more files for other platforms (e.g. `external_extensions_linux.txt`) by following the pattern in `install.sh`.

## How to write a new skill

### 1. Create a folder

```
skills/my-skill/SKILL.md
```

### 2. Add required frontmatter

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---
```

- `name` must be lowercase letters/numbers/hyphens and match the folder name.
- `description` should be specific so the agent knows when to load the skill.

### 3. Add instructions/scripts

A skill can include scripts and references, e.g.:

```
skills/my-skill/
├── SKILL.md
├── scripts/
│   └── run.sh
└── references/
    └── details.md
```

Use relative paths from `SKILL.md` when referring to local files.

### 4. Install and reload

Run:

```bash
./install.sh
```

Then reload Pi with `/reload` if it's running.

## Adding an external skill

Add a line to `external_skills.txt` (one per line):

```
vercel-labs/agent-skills@vercel-react-best-practices
```

Then run `./install.sh`.

## Pi settings

`pi_settings.json` holds our declarative Pi settings (default provider/model,
thinking level, enabled models, the session model-scope list). `install-pi.sh`
**shallow-merges** it onto the live `~/.pi/agent/settings.json` with
`jq -s '.[0] * .[1]'` (existing `*` ours): our declared keys overwrite, but any
key we don't declare is left untouched.

Why merge instead of symlink or copy: Pi *mutates* `settings.json` at runtime —
it owns `packages` (the installed-extension list), `lastChangelogVersion`, and
similar. A symlink would push that runtime churn back into this repo on every
launch; a wholesale copy would wipe it. The overlay keeps this file a clean,
minimal statement of desired settings while letting Pi manage its own state.

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

## MCP servers

MCP server definitions live in `mcp.json` at the repo root. This file is symlinked to `~/.config/mcp/mcp.json` by `install.sh`, making it the global MCP config.

The `pi-mcp-adapter` extension (listed in `external_extensions.txt`) reads this config and bridges MCP tools into Pi. Servers are lazy — they spawn on first tool use and auto-disconnect after idle timeout.

A server entry may set `"directTools": true` (e.g. the `playwright` server does) to promote that server's tools to **direct Pi tools** rather than routing them through the on-demand discovery proxy — they show up as first-class tools without a `/mcp` promote step. This field is Pi-specific: `scripts/install-claude.sh` builds the Claude payload from a whitelist (`command`/`args`/`cwd`/`env` for stdio servers, or `type`/`url`/`transport`/`headers` for url-based remote servers), so `directTools` is naturally dropped for Claude Code.

The `playwright` server is special-cased: instead of an `npx`-spawned server, it runs the `brave-cdp-mcp` launcher in the patched persistent install at `~/.local/playwright-mcp` (`command: bash`, `args: ["brave-cdp-mcp"]`, `cwd: ~/.local/playwright-mcp`) that `scripts/install-pi.sh` creates, patches, and links the launcher into. See the "Per-agent isolated Brave" section below and the install-pi.sh step above.

A second `playwright-main` server runs the **same launcher** with `env: { BRAVE_CDP_REAL: "1" }`, so it connects to the user's real interactive Brave on `:9222` (launched via the `brave-mcp` shell function in myrig) instead of launching an isolated one. It exists so an agent can opt into driving the user's live window (tools namespaced `mcp__playwright-main__*`) without the user restarting the session — both servers are registered from the start; the agent just picks the toolset. It's `directTools: false` (unlike the isolated `playwright`'s `true`) so its ~20 browser tools stay behind the `/mcp` discovery proxy and don't double the direct-tool count in every session; promote them on demand. Caveat: agents must **not** call `browser_close` on this server — it would close the user's real Brave window (the global browser-usage note in myrig spells this out).

### Per-agent isolated Brave (`brave-cdp-mcp`)

Source: `scripts/brave-cdp/brave-cdp-mcp`. Pointing Playwright MCP at one shared Brave over a single CDP endpoint makes every agent grab `browser.contexts()[0]` — the same default context and tab pool — so concurrent agents clobber each other's tabs. The launcher gives **each agent session its own Brave**, using Playwright's **launch mode** (not connect-over-CDP):

- **Default (isolated, launch mode) — macOS *and* Linux with a launchable Brave.** The launcher's `$PPID` *is* the agent process (the MCP server is a direct child of `pi`/`claude` — verified). It seeds a tiny profile at `/tmp/brave-cdp/<agent-pid>` (the encryption key `Local State` + cookie DBs + a symlink to the read-only `Extensions/` dir — ~1 MB, enough for cookie-based logins like Gmail/GitHub), then `exec`s `cli.js --executable-path <Brave> --user-data-dir <profile>` (no `--cdp-endpoint`). Playwright **launches Brave itself, lazily on the first browser tool call**, and **closes it when the MCP server shuts down** (agent exit / stdio EOF). Per-OS specifics:
  - **macOS:** source profile `~/Library/Application Support/BraveSoftware/Brave-Browser`; headed window. Two things are needed for cookies to decrypt → **logged in as you**: (1) `install-pi.sh` patch 2 drops `--use-mock-keychain`/`--password-store=basic` (both Darwin-only) so the launched Brave uses the real "Brave Safe Storage" **keychain** key; and (2) the launch is wrapped in `sudo -n launchctl asuser $(id -u) sudo -n -u $USER …`. Without (2) the Brave inherits the agent's launchd **"Background"** domain — the sesh/tmux server lives there, not your Aqua GUI session — so it can't reach the Security Server, fails the keychain lookup with `errSecInteractionNotAllowed` (-25308), and **silently drops every cookie** (→ logged out). `asuser` re-associates the process with your GUI/Aqua session (the audit-session switch is root-only, hence the outer `sudo`); the inner `sudo -u $USER` drops straight back to your uid so the profile files stay user-owned (root-owned files would defeat the GC). The launcher probes the exact `sudo … asuser … sudo -u` path first and **falls back to a plain launch** (isolation still works, just logged out) when passwordless sudo isn't available. Inline `env` carries `PLAYWRIGHT_MCP_SANDBOX` through sudo's env-stripping. Linux needs none of this (no keychain — see below).
  - **Linux:** source profile `~/.config/BraveSoftware/Brave-Browser`; `--headless`+`--no-sandbox` when there's no `DISPLAY` (cloud/server box), headed on a Linux desktop. Cookies are `v10`/`--password-store=basic` (the hardcoded "peanuts" key — **no keychain**, so patch 2 correctly doesn't run here); the launched Brave decrypts the seed for free. Caveat: a headless box's own Brave profile is often barely logged in, so "logged in as you" is weaker than macOS — the isolated Brave just inherits whatever the box profile has. (See `_dev/experiments/` for the R&D.)
- **Sandbox / the `--no-sandbox` banner.** For **headed** launches (macOS, Linux desktop) the launcher exports `PLAYWRIGHT_MCP_SANDBOX=true` so the Chromium sandbox stays **on**. `@playwright/mcp` otherwise leaves `chromiumSandbox` undefined for an `--executable-path` browser — its config only defaults it for `browserName === "chromium"`, which is never set on this path — so Playwright passes `--no-sandbox` and Brave shows the alarming "unsupported command-line flag: --no-sandbox" banner. The CLI `--sandbox` flag can't fix it (it's mapped back to undefined), so the env var is the only lever. **Headless** launches (cloud Linux, no `DISPLAY`) keep `--no-sandbox` on purpose — the sandbox usually can't initialise there.
- **Why launch mode.** The agent starts the MCP server at session init just to enumerate tools — but `tools/list` returns static schemas and Playwright only creates the browser on the first *tool call*, so **nothing opens for sessions that never browse** (an earlier connect-over-CDP design pre-launched Brave here and opened a window every session). Launch mode also means Playwright owns the browser lifecycle, so there is **no watchdog, no registry, no CDP port pool** — the browser dies with the MCP server.
- **Cleanup.** On startup the launcher GC's `/tmp/brave-cdp/<pid>` dirs (and kills any orphaned Brave) whose agent PID is dead — cheap insurance against a browser orphaned by a hard-killed server. `/tmp`'s 3-day rule and reboot are further backstops.
- **Reuse.** Lazy MCP re-spawn within one agent reuses the same `/tmp/brave-cdp/<agent-pid>` profile (no re-seed).
- **Opt-out / fallback to connect-mode.** `BRAVE_CDP_REAL=1` (or `BRAVE_CDP_PORT=9222`) → connect to your real interactive Brave on `:9222` instead. (This is exactly what the `playwright-main` MCP server sets in its env — see the MCP servers section above.) `BRAVE_CDP_PORT=<n>` → connect to an explicit already-running port. **No launchable Brave** on the box (e.g. termux, or any box without a `brave-browser`/`brave` binary) → connect-only to `:9222`. (Previously *all* non-macOS connected; now Linux-with-Brave launches its own isolated Brave like macOS — so a Linux agent no longer needs a pre-running `:9222` Brave.)
- **Limitation.** The cheap seed only carries cookie-based logins; sites that keep auth in Local Storage / IndexedDB won't be logged in (widen the seed in the launcher if needed).
- **Tunables (mainly for tests):** `BRAVE_CDP_CLI` / `BRAVE_CDP_RUNNER` (cli path / runtime), `BRAVE_CDP_BRAVE_BIN` (Brave binary), `BRAVE_CDP_HEADLESS=1/0` (force headless on/off).

Related follow-up lives in **myrig**: the `brave-mcp` shell function (`home/.myrig/zshenv/coding.sh`) still launches your interactive `:9222` Brave, and the global browser-usage note is in `home/.pi/agent/AGENTS.md`.

### Adding an MCP server

Edit `mcp.json` and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server@latest"],
      "env": { "API_KEY": "${MY_API_KEY}" },
      "lifecycle": "lazy"
    }
  }
}
```

Then run `./install.sh` and `/reload` in Pi.

### Using MCP tools

With `pi-mcp-adapter`, use `/mcp` to see server status and available tools. The adapter exposes a proxy tool that discovers MCP tools on-demand, or you can promote frequently-used tools to direct Pi tools via the `/mcp` panel.

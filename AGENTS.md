# myagent

Personal coding-agent extensions, skills, MCP servers, and configuration for
Pi, Claude Code, and Codex.

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

## Repo structure

```
myagent/
├── AGENTS.md               # This file (CLAUDE.md is a stub that imports it via `@AGENTS.md`)
├── install.sh              # Orchestrator — runs the Pi, Claude, and Codex installers
├── external_extensions.txt     # External extensions to install via `pi install`
├── external_extensions_mac.txt # macOS-only external extensions
├── external_skills.txt         # External skills to install via `npx skills add`
├── pi_settings.json        # Declarative Pi settings, shallow-merged onto ~/.pi/agent/settings.json
├── mcp.json                # MCP server definitions applied to Pi, Claude, and Codex
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
2. Runs `npm install --omit=dev` for any extension that has a `package.json`.
3. Symlinks each folder under `skills/` into `~/.agents/skills/` so Pi can discover local skills.
4. Runs `npm install --omit=dev` for any skill that has a `package.json`.
5. Shallow-merges `pi_settings.json` onto `~/.pi/agent/settings.json` (our keys win, runtime keys preserved — see "Pi settings" below).
6. Symlinks `mcp.json` to `~/.config/mcp/mcp.json` and `~/.pi/agent/mcp.json`.
7. Runs `scripts/configure-pi-tool-binaries.sh` to configure Pi tool binaries.
8. Installs Playwright MCP (patched): persistently installs `@playwright/mcp` into `~/.local/playwright-mcp` and applies three patches — a `Browser.setDownloadBehavior` skip (all platforms, for the CDP-connect/opt-out path), a Chromium-switches patch (**macOS only** — drop `--use-mock-keychain`/`--password-store=basic` so a Brave that Playwright *launches* can decrypt the seeded profile's cookies; Linux deliberately keeps `--password-store=basic` for its portable cookie key), and the `browser_close` tool description (all platforms; upstream ships "Close the page", which misled agents into thinking it only closes a tab and leaving the per-agent Brave resident all session; it actually disposes the whole browser process, so the patched text tells agents to close it when done). The installer locates each patch target by string search, since current playwright-core (≥1.61) bundles these into `lib/coreBundle.js` (formerly the separate `crBrowser.js` / `chromiumSwitches.js`). It symlinks `brave-cdp-mcp`, `mcp-lazy`, `mcp-lazy-shim`, `remote-playwright-mcp`, and `remote-playwright-host` next to that install, and warms the lazy-shim cache (`mcp-lazy-cache.json`) once so a non-browsing session skips the ~128 MB Node `cli.js` (see "Lazy MCP proxy shim" below). (The Playwright servers in `mcp.json` run those launchers — see below.)
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

**`scripts/install-codex.sh`** — Codex side:
1. Reads every server from `mcp.json` and validates the full set before changing Codex config.
2. Re-applies stdio servers with `codex mcp remove/add`; like Claude, entries with `cwd` are safely wrapped in `sh -c "cd … && exec …"` because the installed `codex mcp add` command has no `cwd` flag.
3. Applies simple streamable-HTTP entries by URL and fails loudly rather than dropping unsupported static headers.
4. Records the server names it manages in `.install-state/codex_mcp.txt`; with `--prune`, removes previously managed names no longer declared.

Codex CLI, the Codex IDE extension, and the Codex desktop app share
`~/.codex/config.toml`. Restart Codex clients after install. Codex does not read
myagent's JSON MCP config on its own; this installer is the explicit bridge.

## Local extensions

The extensions that ship in this repo (each under `extensions/<name>/`; see the per-folder `README.md` / `index.ts` header for detail):

- **agents-local** — appends a project's `AGENTS.local.md` (personal, uncommitted notes) to the system prompt when one is found alongside `AGENTS.md`.
- **compact-tools** — compact tool-call rendering plus a keyboard-driven split-pane tool-output viewer (`README.md`).
- **hooks** — Claude Code / Codex–style lifecycle hooks: shell commands run on Pi events (from `hooks.json`), able to block or modify the event (`README.md`).
- **message-barrel** — save draft messages into a barrel and paste them back into the input editor later (`README.md`).
- **pi-hashline-edit** — replaces the built-in `read`/`edit` tools with a hash-anchored line-editing workflow that rejects stale edits (`README.md`).
- **privatemode** — registers PrivateMode AI (E2E-encrypted confidential computing) as an OpenAI-compatible provider, auto-starting its local podman proxy on demand.
- **sesh-agent-state** — ⚠️ **not authored here**: a symlink to
  `../../sesh/integrations/pi/sesh-agent-state`. The extension lives in the **sesh** repo
  (edit it there); myagent only registers it so `install-pi.sh` symlinks it into
  `~/.pi/agent/extensions/` like a local one. It reports pi turn lifecycle to the sesh daemon
  via `sesh thread report-state`, giving sesh exact busy/idle (`state_authority = reported`)
  instead of the pane content-diff heuristic. Inert outside a sesh thread (no `SESH_THREAD_ID`
  → it registers nothing). The claude twin is the hook set in myrig's `home/.claude/settings.json`.
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

MCP server definitions live in `mcp.json` at the repo root. The Pi installer
symlinks it to the shared/Pi config paths; the Claude and Codex installers
translate the same declarations into those clients' user-scoped configs.

The `pi-mcp-adapter` extension (listed in `external_extensions.txt`) reads this config and bridges MCP tools into Pi. Servers are lazy — they spawn on first tool use and auto-disconnect after idle timeout.

A server entry may set `"directTools": true` (e.g. the `playwright` server does) to promote that server's tools to **direct Pi tools** rather than routing them through the on-demand discovery proxy — they show up as first-class tools without a `/mcp` promote step. This field is Pi-specific: `scripts/install-claude.sh` builds the Claude payload from a whitelist (`command`/`args`/`cwd`/`env` for stdio servers, or `type`/`url`/`transport`/`headers` for url-based remote servers), so `directTools` is naturally dropped for Claude Code.

The `playwright` server is special-cased: instead of an `npx`-spawned server, it runs the `brave-cdp-mcp` launcher in the patched persistent install at `~/.local/playwright-mcp`, fronted by the **lazy shim** (`command: bash`, `args: ["mcp-lazy", "bash", "brave-cdp-mcp"]`, `cwd: ~/.local/playwright-mcp`) that `scripts/install-pi.sh` creates, patches, and links the launchers into. `mcp-lazy` runs the Python `mcp-lazy-shim` when python3 + a warmed cache are present (serving `initialize`/`tools/list` from cache so a non-browsing session holds an ~12 MB shim instead of a ~128 MB Node `cli.js`), and otherwise falls straight through to `brave-cdp-mcp` — see the "Lazy MCP proxy shim" section below. See also the "Per-agent isolated Brave" section and the install-pi.sh step above.

A second `playwright-main` server runs the **same launcher** with `env: { BRAVE_CDP_REAL: "1" }`, so it connects to the user's real interactive Brave on `:9222` (launched via the `brave-mcp` shell function in myrig) instead of launching an isolated one. It exists so an agent can opt into driving the user's live window (tools namespaced `mcp__playwright-main__*`) without the user restarting the session — both servers are registered from the start; the agent just picks the toolset. It's `directTools: false` (unlike the isolated `playwright`'s `true`) so its ~20 browser tools stay behind the `/mcp` discovery proxy and don't double the direct-tool count in every session; promote them on demand. Caveat: agents must **not** call `browser_close` on this server — it would close the user's real Brave window (the global browser-usage note in myrig spells this out).

**`:9222` memory gate.** Claude Code and Codex spawn every configured stdio MCP server *eagerly* at session start (only Pi honours `lifecycle: lazy` — both surfaces confirmed to have no lazy stdio option). So a globally-registered `playwright-main` used to leave one resident ~65 MB Node wrapper **per session** attached to a `:9222` that is not running — on a headless box it can never be used, yet under a many-session sweep this dead weight reached multiple GB of swap and took mymain down (2026-08-06). The launcher now **probes the CDP port in `BRAVE_CDP_REAL=1` mode and `exit 0`s before the MCP handshake when nothing is listening** (see "Opt-out / fallback to connect-mode" below), so `playwright-main` costs nothing except when your interactive Brave is actually up. A headless/background agent showing `playwright-main` as *failed* in `/mcp` is the **expected, healthy** state; run `brave-mcp` to bring up `:9222` (then reconnect via `/mcp`) to use it. This gate is a stopgap for the eager-spawn root cause; the durable fix is a lazy proxy shim (a tiny process that answers `initialize`/`tools/list` cheaply and only spawns the heavy Node cli.js on first tool call), which also reclaims the *isolated* `playwright` wrapper for non-browsing sessions.

Two remote servers use the same upstream tool surface on a chosen Mac:

- **`playwright-macstudio`** — the preferred always-on, high-RAM acquisition worker.
- **`playwright-macbook`** — the opt-in laptop worker; it can be asleep/offline.

Both are `directTools: false` so Pi does not eagerly add two more copies of the
Playwright schemas to every prompt. Their transport and lifecycle are described
under "Remote Playwright workers" below.

### Per-agent isolated Brave (`brave-cdp-mcp`)

Source: `scripts/brave-cdp/brave-cdp-mcp`. Pointing Playwright MCP at one shared Brave over a single CDP endpoint makes every agent grab `browser.contexts()[0]` — the same default context and tab pool — so concurrent agents clobber each other's tabs. The launcher gives **each agent session its own Brave**, using Playwright's **launch mode** (not connect-over-CDP):

- **Default (isolated, launch mode) — macOS *and* Linux with a launchable Brave.** The launcher's `$PPID` *is* the agent process (the MCP server is a direct child of `pi`/`claude` — verified). It seeds a tiny profile at `/tmp/brave-cdp/<agent-pid>` (the encryption key `Local State` + cookie DBs + a symlink to the read-only `Extensions/` dir — ~1 MB, enough for cookie-based logins like Gmail/GitHub), then `exec`s `cli.js --executable-path <Brave> --user-data-dir <profile>` (no `--cdp-endpoint`). Playwright **launches Brave itself, lazily on the first browser tool call**, and **closes it when the MCP server shuts down** (agent exit / stdio EOF). Per-OS specifics:
  - **macOS:** source profile `~/Library/Application Support/BraveSoftware/Brave-Browser`; headed window. Two things are needed for cookies to decrypt → **logged in as you**: (1) `install-pi.sh` patch 2 drops `--use-mock-keychain`/`--password-store=basic` (both Darwin-only) so the launched Brave uses the real "Brave Safe Storage" **keychain** key; and (2) the launch is wrapped in `sudo -n launchctl asuser $(id -u) sudo -n -u $USER …`. Without (2) the Brave inherits the agent's launchd **"Background"** domain — the sesh/tmux server lives there, not your Aqua GUI session — so it can't reach the Security Server, fails the keychain lookup with `errSecInteractionNotAllowed` (-25308), and **silently drops every cookie** (→ logged out). `asuser` re-associates the process with your GUI/Aqua session (the audit-session switch is root-only, hence the outer `sudo`); the inner `sudo -u $USER` drops straight back to your uid so the profile files stay user-owned (root-owned files would defeat the GC). The launcher probes the exact `sudo … asuser … sudo -u` path first and **falls back to a plain launch** (isolation still works, just logged out) when passwordless sudo isn't available. Inline `env` carries `PLAYWRIGHT_MCP_SANDBOX` through sudo's env-stripping. Linux needs none of this (no keychain — see below).
  - **Linux:** source profile `~/.config/BraveSoftware/Brave-Browser`; `--headless`+`--no-sandbox` when there's no `DISPLAY` (cloud/server box), headed on a Linux desktop. Cookies are `v10`/`--password-store=basic` (the hardcoded "peanuts" key — **no keychain**, so patch 2 correctly doesn't run here); the launched Brave decrypts the seed for free. Caveat: a headless box's own Brave profile is often barely logged in, so "logged in as you" is weaker than macOS — the isolated Brave just inherits whatever the box profile has. (See `_dev/experiments/` for the R&D.)
- **Sandbox / the `--no-sandbox` banner.** For **headed** launches (macOS, Linux desktop) the launcher exports `PLAYWRIGHT_MCP_SANDBOX=true` so the Chromium sandbox stays **on**. `@playwright/mcp` otherwise leaves `chromiumSandbox` undefined for an `--executable-path` browser — its config only defaults it for `browserName === "chromium"`, which is never set on this path — so Playwright passes `--no-sandbox` and Brave shows the alarming "unsupported command-line flag: --no-sandbox" banner. The CLI `--sandbox` flag can't fix it (it's mapped back to undefined), so the env var is the only lever. **Headless** launches (cloud Linux, no `DISPLAY`) keep `--no-sandbox` on purpose — the sandbox usually can't initialise there.
- **Why launch mode.** The agent starts the MCP server at session init just to enumerate tools — but `tools/list` returns static schemas and Playwright only creates the browser on the first *tool call*, so **nothing opens for sessions that never browse** (an earlier connect-over-CDP design pre-launched Brave here and opened a window every session). Launch mode also means Playwright owns the browser lifecycle, so there is **no watchdog, no registry, no CDP port pool** — the browser dies with the MCP server.
- **Cleanup.** On startup the launcher GC's `/tmp/brave-cdp/<pid>` dirs (and kills any orphaned Brave) whose owner PID is dead — cheap insurance against a browser orphaned by a hard-killed server. `/tmp`'s 3-day rule and reboot are further backstops.
- **Reuse.** Lazy MCP re-spawn within one local agent reuses the same `/tmp/brave-cdp/<agent-pid>` profile (no re-seed); each remote SSH channel gets its own live owner PID.
- **Profile owner override.** Local Pi/Claude/Codex launches still default to `$PPID`
  (the agent PID). The remote transport passes `BRAVE_CDP_PROFILE_OWNER_PID`
  from the unique remote command-shell `$$`; the launcher accepts only a live,
  canonical decimal PID of at least 2 (no leading zero). Validation is lexical,
  so oversized caller text never enters shell arithmetic. This preserves
  numeric `kill -0` GC while avoiding collisions between SSH channels that
  share one multiplexed sshd parent.
- **Opt-out / fallback to connect-mode.** `BRAVE_CDP_REAL=1` (or `BRAVE_CDP_PORT=9222`) → connect to your real interactive Brave on `:9222` instead. (This is exactly what the `playwright-main` MCP server sets in its env — see the MCP servers section above.) **`BRAVE_CDP_REAL=1` mode is gated:** the launcher first probes the CDP port with a dependency-free bash `/dev/tcp` connect to `127.0.0.1:<port>` (`cdp_listener_up`, port numeric-validated so caller text is never `eval`'d; works under Debian/macOS bash — the launcher's `#!/usr/bin/env bash`, never zsh which lacks `/dev/tcp`), and if nothing is listening it logs and `exit 0`s **before** spawning the Node wrapper — so an eagerly-spawned `playwright-main` on a box with no interactive Brave leaves no resident process (verified: Claude *and* Codex mark it failed once, no respawn thrash). `BRAVE_CDP_PORT=<n>` (without `REAL`) → connect to an explicit already-running port; this path and the no-Brave path below are **not** gated (both are deliberate connect-only opt-ins where the caller asserts the endpoint). **No launchable Brave** on the box (e.g. termux, or any box without a `brave-browser`/`brave` binary) → connect-only to `:9222`. (Previously *all* non-macOS connected; now Linux-with-Brave launches its own isolated Brave like macOS — so a Linux agent no longer needs a pre-running `:9222` Brave.)
- **Limitation.** The cheap seed only carries cookie-based logins; sites that keep auth in Local Storage / IndexedDB won't be logged in (widen the seed in the launcher if needed).
- **Tunables (mainly for tests):** `BRAVE_CDP_CLI` / `BRAVE_CDP_RUNNER` (cli path / runtime), `BRAVE_CDP_BRAVE_BIN` (Brave binary), `BRAVE_CDP_HEADLESS=1/0` (force headless on/off).

Related follow-up lives in **myrig**: the `brave-mcp` shell function (`home/.myrig/zshenv/coding.sh`) still launches your interactive `:9222` Brave, and the global browser-usage note is in `home/.pi/agent/AGENTS.md`. That sibling-repo note currently explains only `playwright` and `playwright-main`; update it separately after deployment if the remote worker names should be advertised in every agent session. This task does not patch myrig.

### Lazy MCP proxy shim (`mcp-lazy` / `mcp-lazy-shim`)

Source: `scripts/brave-cdp/mcp-lazy` (bash front) and `scripts/brave-cdp/mcp-lazy-shim`
(Python proxy). Claude Code and Codex spawn **every** configured stdio MCP server
eagerly at session start, and neither has a lazy/on-demand option (only Pi honours
`lifecycle: lazy`). So without this, every Claude/Codex session held a resident
~128 MB Node `@playwright/mcp` process even if it never browsed; under a many-session
sweep on mymain that standing memory (plus the inert `playwright-main` class)
exhausted swap and rebooted the box (2026-08-06). The `:9222` gate (above) removed the
`playwright-main` half; this shim removes the isolated-`playwright` half.

- **`mcp-lazy` (bash) — the graceful front.** Invoked as `bash mcp-lazy bash brave-cdp-mcp`.
  If `python3` **and** a warmed cache (`mcp-lazy-cache.json`) are present it `exec`s the
  Python shim; otherwise it `exec`s the downstream launcher directly (today's eager
  behaviour) — so browsing never depends on python3 and the shim can't regress a box
  that lacks it.
- **`mcp-lazy-shim` (Python) — the lazy proxy.** Answers `initialize`, `tools/list`,
  `ping` from the cached snapshot (spawning nothing); on the **first** request that
  needs the real server (a `tools/call`, or anything not served from cache) it lazily
  spawns the downstream, does a private handshake with it (replaying the client's
  `initialize`, swallowing the downstream's init response under a private id `_shim_init_`),
  forwards the triggering request, then becomes a transparent full-duplex byte pipe. A
  corrupt/missing cache → EAGER transparent relay (correctness never depends on the
  cache). Idle RSS ~12 MB vs ~128 MB for the resident `cli.js` — and the 12 MB stays
  resident rather than being the 128 MB that swaps out and thrashes.
- **Cache.** `install-pi.sh` warms `~/.local/playwright-mcp/mcp-lazy-cache.json` once per
  install via `mcp-lazy-shim --warm bash brave-cdp-mcp` (the handshake launches no
  browser), so it always matches the pinned `@playwright/mcp` version. The shim
  auto-discovers the cache as a sibling of its own path (no env var needed);
  `MCP_LAZY_CACHE` overrides. Observability env: `MCP_LAZY_DEBUG=1` (log each method +
  cache-served vs activation), `MCP_LAZY_SPAWN_LOG=<path>` (append a line on activation).
- **Scope.** Applied to the isolated `playwright` server only. `playwright-main` keeps the
  `:9222` gate (already ~free when down; shimming it would collide with the gate's
  clean-exit on activation). The remote workers are locally cheap (ssh) and unaffected.
  Validated end-to-end against the real `@playwright/mcp` and live Claude, Codex, and Pi
  agents; R&D in `_dev/experiments/03_lazy_mcp_proxy_shim/`.

### Remote Playwright workers (`remote-playwright-mcp`)

Source: `scripts/brave-cdp/remote-playwright-mcp` (client side) and
`remote-playwright-host` (target side). This is a narrow stdio transport, not a
general remote executor:

1. The client accepts exactly `macstudio` or `macbook`; unknown/disallowed names
   fail with exit 64 before SSH. It invokes the canonical `ssh-target` executable,
   so host/user/port selection and Tailscale/SSH trust remain owned by myrig.
2. The remote command is a fixed literal. It sets
   `BRAVE_CDP_PROFILE_OWNER_PID=$$` from that channel's command shell and then
   `exec`s the installed target entry point. Callers cannot supply an arbitrary
   host, SSH option, path, or remote command.
3. `remote-playwright-host` requires macOS, the exact live owner PID, target
   Node/Playwright/Brave/profile paths, an active GUI launchd domain, and the
   passwordless `launchctl asuser` keychain bridge. It fails on stderr before
   emitting MCP stdout if the target is unprepared or incompatible.
4. The target entry point forces isolated launch mode and execs the normal
   `brave-cdp-mcp`. The target's installed `@playwright/mcp` owns initialize,
   `tools/list`, and every browser call; no Playwright tool/schema is duplicated.

**Isolation.** OpenSSH multiplexes the connection but each command channel has
its own shell PID. Passing that PID explicitly is load-bearing: using the shared
sshd parent made two clients select one profile and Brave rejected the second.
Every later `exec` preserves the chosen PID as the outer MCP process, so it stays
alive for the entire session and disappears with the SSH channel.

**Lifecycle.** Normal stdio EOF makes Playwright dispose Brave, then SSH exits.
If the client is hard-killed, SSH channel teardown is the first cleanup path;
the next target launcher additionally kills any process whose numeric profile
owner no longer passes `kill -0` and removes the stale profile. Target `/tmp`
aging/reboot are final backstops. A true network partition may keep sshd's
session PID alive until SSH/OS timeout; GC deliberately does not kill an owner
that still appears live.

**Security/data locality.** No server port is opened. The target retains its
HOME, Playwright version, Brave profile, cookies, login databases, keychain
access, downloads, and output files. MCP text/image results and screenshots are
the only browser data carried back over SSH. Downloads and browser-visible local
file paths refer to the target, not the client.

**Preparation and failures.** Run myagent's installer on both client and target.
Mac Studio is the empirically verified default worker; MacBook may be offline.
An offline allowed target fails through `ssh-target`'s bounded connect timeout.
Adding another allowed worker requires a deliberate myrig machine-inventory
change plus an explicit allow-list/config update here; do not accept raw hosts.

R&D and measurements are in
`_dev/experiments/02_remote_stdio_playwright_worker/FINDINGS.md`.

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

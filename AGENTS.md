# myagent

Personal Pi coding agent extensions, skills, and configuration.

## Repo structure

```
myagent/
├── AGENTS.md               # This file (also symlinked as CLAUDE.md)
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
8. Installs Playwright MCP (patched): persistently installs `@playwright/mcp` into `~/.local/playwright-mcp` and patches `crBrowser.js` to skip `Browser.setDownloadBehavior` so Brave's CDP connection works. Also symlinks the `brave-cdp-mcp` launcher (from `scripts/brave-cdp/`) next to that install. (The `playwright` server in `mcp.json` runs that launcher — see "Per-agent isolated Brave" below.)
9. Reads `external_extensions.txt` (+ `external_extensions_mac.txt` on macOS) and runs `pi install <source>`.
10. Reads `external_skills.txt` and runs `npx -y skills add <source> -g -y`.
11. With `--prune`, removes stale local symlinks and uninstalls previously managed external entries.

After running install, reload Pi with `/reload` if it's running.

**`scripts/install-claude.sh`** — Claude Code side:
1. Symlinks each folder under `skills/` into `~/.claude/skills/` so Claude discovers local skills.
2. Symlinks each external skill (resolved via `~/.agents/skills/<name>`) into `~/.claude/skills/`.
3. For every server in `mcp.json`, runs `claude mcp remove <name> -s user` then `claude mcp add-json <name> ... -s user` (idempotent re-apply at user scope). Servers with a `cwd` field are wrapped as `sh -c "cd <cwd> && exec ..."` because `claude mcp add-json` silently drops `cwd`. `lifecycle` is Pi-specific and stripped.
4. With `--prune`, removes Claude skill symlinks and MCP servers it previously installed but are no longer listed.

Restart Claude Code to pick up new skills/MCP servers.

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

Two keys are deliberately **not** declared here:

- **`packages`** — the installed-extension list is owned by
  `external_extensions.txt` (+ the mac variant), applied via `pi install` in the
  step above. Declaring it here too would recreate a split-brain. (This split
  used to live across repos: myrig's `home/.pi/agent/settings.json.jinja` once
  hardcoded `packages`, re-seeding entries — e.g. `pi-slopchop` — that myagent
  had dropped. That template has been removed; myagent is now the sole owner.)
- **`shellPath`** — Pi auto-detects the shell; a static value would break termux
  (whose zsh lives under `/data/data/com.termux/...`).

To add a package, edit `external_extensions.txt` — not this file.

## MCP servers

MCP server definitions live in `mcp.json` at the repo root. This file is symlinked to `~/.config/mcp/mcp.json` by `install.sh`, making it the global MCP config.

The `pi-mcp-adapter` extension (listed in `external_extensions.txt`) reads this config and bridges MCP tools into Pi. Servers are lazy — they spawn on first tool use and auto-disconnect after idle timeout.

The `playwright` server is special-cased: instead of an `npx`-spawned lazy server, it runs the `brave-cdp-mcp` launcher in the patched persistent install at `~/.local/playwright-mcp` (`command: bash`, `args: ["brave-cdp-mcp"]`, `cwd: ~/.local/playwright-mcp`) that `scripts/install-pi.sh` creates, patches for Brave's CDP, and links the launcher into. See the "Per-agent isolated Brave" section below and the install-pi.sh step above.

### Per-agent isolated Brave (`brave-cdp-mcp`)

Source: `scripts/brave-cdp/brave-cdp-mcp`. Connecting Playwright MCP to one shared Brave over a single CDP endpoint makes every agent grab `browser.contexts()[0]` — the same default context and tab pool — so concurrent agents clobber each other's tabs. The launcher fixes this by giving **each agent session its own Brave**:

- **Default (isolated).** The launcher's `$PPID` *is* the agent process (the MCP server is spawned as a direct child of `pi`/`claude` — verified). It allocates a debug port from a locked registry pool (`9223–9422`, registry at `~/.local/brave-cdp/registry`), seeds a profile at `/tmp/brave-cdp/<port>` (copies the real Brave profile's login state — cookies/Local State/etc. — and **symlinks** the heavy read-only `Extensions/` dir, ~155M), launches Brave on that port, then `exec`s the real `cli.js` against it. The seeded profile means the isolated Brave is **logged in as you** (cookies decrypt via the shared macOS "Brave Safe Storage" keychain key).
- **Teardown (watchdog).** When it launches a browser it also spawns a detached, `nohup`'d watchdog that polls the agent PID and, on agent death (clean exit, crash, kill — tmux or not), kills *that specific* Brave PID (verified to still be ours, guarding PID reuse), removes the `/tmp` profile, and frees the registry slot. `/tmp`'s 3-day rule and reboot are backstops.
- **Reuse.** On lazy MCP re-spawn within one agent, the registry returns the same port and the launcher reconnects to the existing Brave (no second browser, no second watchdog).
- **Opt-out.** `BRAVE_CDP_REAL=1` (or `BRAVE_CDP_PORT=9222`) → connect to your real interactive Brave on `:9222` instead. `BRAVE_CDP_PORT=<n>` → connect to an explicit already-running port. Non-macOS → connect-only to `:9222` (preserves prior behavior, e.g. termux).
- **Tunables (mainly for tests):** `BRAVE_CDP_WATCH_INTERVAL` (watchdog poll secs, default 30), `BRAVE_CDP_WD_DEBUG` (path for watchdog lifecycle log), `BRAVE_CDP_CLI`/`BRAVE_CDP_RUNNER` (substitute the cli path / runtime).

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

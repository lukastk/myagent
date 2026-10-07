# Extension ownership and development

On-demand reference extracted from the repository guide on 2026-10-07.
Paths in code spans are repository-root-relative unless explicitly qualified;
example paths and installed-home paths are not checkout files.
Dated incidents and validation results are historical observations, not a claim
about every currently installed runtime. Read only for the relevant task.

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
- **session-model** — session-only model switching: `/smodel` plus `Ctrl+Shift+L` (selector) / `Ctrl+Shift+P`/`K` (cycle next/previous). It reads pi's native `enabledModels` scope rather than keeping its own list — edit that scope with pi's built-in `/scoped-models`.
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
- `pi.registerShortcut(key, def)` — register a keyboard shortcut. Bind extension shortcuts on **`Ctrl+Shift+<letter>`, never `Ctrl+Alt`**: inside mycockpit, tmux has no Super modifier and folds Super/Cmd into Meta, so desktop `Ctrl+Super`/`Ctrl+Cmd` chords reach Pi as `Ctrl+Alt` and collide (a44f7e1; rationale in the `extensions/session-model/index.ts` header). Stick to letters, and avoid foot's reserved `Ctrl+Shift+{c,v,r,n,o,u,x,z}`.
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

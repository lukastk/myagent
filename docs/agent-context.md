# Shared agent context policy

The shared/global instructions and Pi tool-exposure pass was implemented
2026-10-07. A separate repository-only pass now keeps `AGENTS.md` concise and
routes installer, extension/skill tutorials, browser architecture and operational
history to on-demand topic docs. `AGENTS.local.md`, `CLAUDE.md`, the agents-local
loader, existing skills and runtime configuration are unchanged by that pass.
The current declaration is `mcp.json`: **all** servers use search/deferred
exposure, including local Playwright.

## Ownership and loading

- **myrig** owns the shared core at `home/.pi/agent/AGENTS.md`.
  Its home installer links that to `~/.pi/agent/AGENTS.md`.
- `home/.claude/CLAUDE.md` imports `@~/.pi/agent/AGENTS.md`.
- `home/.codex/AGENTS.md` is a relative symlink to the same source, so Codex
  reads the actual text (not an unsupported Claude-style import).
- Detailed guides live in myrig's `home/.config/myagent/reference/`, installed
  at `~/.config/myagent/reference/`. The core has task triggers and ordinary
  paths, **not eager imports**. Never load the reference directory wholesale.
- **myagent** owns tools/MCP. Every server is `directTools: "search"` in Pi,
  including local Playwright. `lifecycle: "lazy"` remains independent: lazy
  transport saves processes/RAM; deferred declarations save model context.
- The web extension exposes `web_search` and `fetch` directly. Its alternative
  Puppeteer `browser` is `exposure: "deferred"`, discoverable/callable through
  codemode without declaring it to every model request. Prefer Playwright
  with Brave for normal browsing and user authentication.
- The web research persona is used only in search-provider requests. It is
  not appended to the parent coding agent's system prompt.

Claude/Codex installers still translate transport fields only; Pi's exposure
setting is not a promise about another harness's native tool-search behaviour.
Do not count every installed MCP schema as eagerly loaded on those clients.
Do not raise Codex's project-instruction cap to hide oversized project docs.

## Budgets and audit

The shared core has a **9,000 UTF-8 byte** regression budget in myrig's
`scripts/test-agent-context.py`. A failure is a request to move specialized
material into an appropriately routed reference, not permission to truncate it.
The test also guards safety-critical rules, reference targets, and the real
home installer's Pi/Claude/Codex wiring and idempotence.

```sh
# In myagent: read-only inventory, including project/skill sizes for later work
python3 scripts/audit-context.py
python3 scripts/audit-context.py --installed  # fails on missing/mismatched instruction wiring

# In myrig: hermetic actual home-installer test
uv run --with jinja2 python scripts/test-agent-context.py

# In myagent: config/installer guards
python3 scripts/test-install-pi-extensions.py
bash scripts/test-install-codex.sh

# Real installed Pi SDK, deterministic provider, no model API calls
node scripts/test-context-exposure.mjs "$(npm root -g)/@earendil-works/pi-coding-agent"
```

The SDK test uses a temporary HOME and no real credentials, checks the parent
model request as well as the registry, and calls the deferred Puppeteer close
operation through real QuickJS without launching a browser. It explicitly
handles Pi 0.99's `Context.tools` and Pi 1.x's system-message `toolsAdded` format.

For the optional real isolated-Brave smoke test, set
`CONTEXT_TEST_MCP_ADAPTER` to the installed adapter's absolute `index.ts` and
`CONTEXT_TEST_PLAYWRIGHT_DIR` to the absolute `~/.local/playwright-mcp` directory
before running the same command. This tests cold-cache connect, deferred
registration, native discovery, navigation to a local `data:` page, and close.
It configures **only local Playwright**, uses a temporary HOME/profile, and
never opens the user's interactive window or remote workers.

### Initial measurements

On pocket4, using `o200k_base` to compare source text (not provider billing):

| Material | Before | After |
|---|---:|---:|
| Shared core | 7,525 tokens / 29,290 bytes | 1,882 tokens / 7,758 bytes |
| Local Playwright | 24 upfront schemas, about 3,400 tokens | deferred |
| Puppeteer browser declaration | about 1,100 tokens upfront | deferred |
| Parent research persona | 370 tokens | absent |

The audit CLI deliberately uses dependency-free **characters / 4** estimates,
labelled as such; it does not silently claim these are tokenizer measurements.
Caching or collapsing TUI output does not remove model-visible context.

## Repository context trimming (2026-10-07)

`AGENTS.md` is now the operating guide and task-to-reference map. Its former
sections are preserved in ordinary, on-demand docs:

- [Workspace operations](workspace-operations.md): box adoption and SSH guidance.
- [Installation and settings](installation-and-settings.md): installer steps,
  prune ownership, settings/model rationale and fullscreen history.
- [Extension development](extension-development.md): ownership inventory,
  tutorials, APIs, lifecycle events and keyboard constraints.
- [Skill development](skill-development.md): authoring and distribution tutorial.
- [MCP and browsers](mcp-and-browsers.md): server/OAuth guidance, isolation,
  keychain, lazy shim, remote transport and dated incident history.

No runtime, skill, loader, global configuration or private local-memory content
changed. `CLAUDE.md` still imports only the concise core and private local memory;
none of the topic docs is an eager import. Historical observations in the moved
guides are labelled as such, and stale local-Playwright direct-exposure guidance
is corrected to match `mcp.json`.

### Project eager-source measurement

UTF-8 bytes and **characters / 4 estimates**, not tokenizer/provider billing:

| Project source | Before bytes | After bytes | Before estimate | After estimate |
|---|---:|---:|---:|---:|
| `AGENTS.md` | 46,642 | 6,935 | 11,553.5 | 1,733.25 |
| Private local memory (unchanged) | 1,384 | 1,384 | 345.5 | 345.5 |
| `CLAUDE.md` import stub (unchanged) | 28 | 28 | 7 | 7 |
| **Total including imports, counted once** | **48,054** | **8,347** | **11,906** | **2,085.75** |

This is an **82.6% byte reduction** in the repository eager-source inventory,
including local memory without publishing it. Pi loads core + local memory
(48,026 → 8,319 source bytes); the conservative total also counts the Claude
stub, not another copy of its imported content. Harness-generated headings and
unchanged global instructions, tool schemas and skill metadata are outside this
repository delta. The root instruction scan found no other project instruction
files/imports; ordinary linked docs are not counted as eager content.

Validation: read-only context audit, local link/anchor and concrete path checks,
section-preservation comparison against the former guide, whitespace/diff review,
and confirmation that private memory and the Claude import stub are unchanged.
No browser, integration suite, installation, push or deployment was run for this
documentation-only pass.

## Deployment

Push both repos. Deploy myrig home files on all machines; myagent's existing
extension and MCP symlinks pick up its checkout changes. Its normal installer
remains the way to create missing links. Keep the patched browser install,
lazy shim, adapter fork, and native-codemode configuration in place.

Existing Pi sessions need `/reload`; Claude/Codex sessions should restart to
pick up global instruction changes. Do not interrupt other agents mid-task.

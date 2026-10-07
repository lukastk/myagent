# Fresh-session context: controlled Pi SDK measurement

**This is not a full installed/default session, and these are not billed tokens.**
Every JSON report carries `isFullDefaultSession: false`, `isProviderBilling: false`,
the profile name, exclusions, and limitations. Do not remove those labels when
quoting the figures.

## Run

```sh
# From myagent; requires Linux, bubblewrap, and Node with --permission support.
node scripts/measure-session-context.mjs \
  "$(npm root -g)/@earendil-works/pi-coding-agent"

# Optional absolute project paths replace the three default projects.
# The neutral temporary cwd is always measured first.
node scripts/measure-session-context.mjs \
  "$(npm root -g)/@earendil-works/pi-coding-agent" \
  "$HOME/mysetup/myagent" "$HOME/mysetup/sesh" "$HOME/mysetup/myrig"
```

Default projects are this checkout and its `sesh`/`myrig` siblings. Discovery uses
`$PI_CODING_AGENT_DIR`, or `~/.pi/agent`, and the installed skill copies. Output is
JSON containing only measurements, names, paths, and methodological metadata.
Private instructions, skill bodies, request payloads, credentials, and real
session records are never printed or written as measurement artifacts. Redirect
stdout to an appropriately private location if retaining a report.

The tool requires the installed `agents-local`, `pi-hashline-edit`, and `web`
extensions to be enabled. Missing dependencies/resources, unsupported SDK APIs,
missing configured packages, unsupported npm package declarations, sandbox
failure, and unexpected request shapes fail the run; there is no smaller fallback
profile. Current support is already-installed git/local packages. It never
installs or updates packages. macOS/Termux are not supported by this sandboxed
measurement command.

## What actually runs

The approved profile is **`controlled-sdk-agents-local-hashline-web-codemode`**:

1. A separate worker starts inside bubblewrap with the host filesystem read-only,
   a single writable temporary directory, isolated network/PID namespaces, and a
   clean environment. Node permissions additionally prohibit child processes and
   writes outside scratch. Native addons are allowed for installed dependencies;
   this is an audited-code measurement, not a sandbox for hostile extensions.
2. The installed SDK's package/resource discovery reads actual settings and
   resources. In-memory settings preserve global/project discovery and tool
   presentation fields (`packages`, `extensions`, `skills`, `defaultTools`,
   `codemode`), with explicit in-memory project trust. Provider/proxy settings,
   credential commands, session persistence, retry, and cache warming are not
   activated. `PI_OFFLINE=1` prevents package/model network refresh.
3. `DefaultResourceLoader` performs normal installed instruction and skill
   discovery, including ancestor instructions, package-declared skills,
   `~/.pi/agent/skills`, and `~/.agents/skills`. `noExtensions: true` prevents
   automatic execution; only the three named installed extensions and inline
   native codemode/fake-provider factories load. Prompt templates and themes are
   excluded. Operational extensions' dynamic resources are also excluded.
4. `ModelRuntime` receives `InMemoryCredentialStore`, `InMemoryModelsStore`,
   `modelsPath: null`, and disabled model refresh. Settings and sessions are
   in-memory. Real auth/model/session files are not loaded. The real HOME is
   retained solely for ordinary discovery; XDG/cache/agent runtime outputs point
   into scratch.
5. `createAgentSession`, extension binding, prompt assembly, and the agent loop
   run against the real installed SDK. The deterministic provider captures its
   normalized `streamSimple(model, context)` input **in memory** and returns
   `done`. It has no HTTP client and never requests a tool call.
6. Each cwd gets a fresh neutral request, then a separate fresh in-memory session
   for **each** `/skill:name` expansion, including manual-only skills. No skill
   instructions are executed. All sessions are disposed and scratch is removed.

Assertions require exactly one fake-provider request per session, only system
and user messages, no session file, the expected tools, and no browser/MCP
schema. Initial declarations are checked in **`messages[0].toolsAdded`**, not a
fictional top-level `tools` field. Both previously tested hosts, Pi 0.99.1 and
1.0.4, use this transcript arrangement; this tool's validation was on **1.0.4**.
It requires the current in-memory ModelRuntime API rather than guessing older
SDK behavior.

### Why not start every installed extension?

A full startup is not passive. Inspection found:

- `pi-rpc-socket` creates/unlinks a socket path and calls `listen()` during
  `session_start`, even without an interactive UI.
- `hooks` can spawn configured shell commands on startup/prompt/turn events and
  alter model context.
- `sesh-agent-state` can report lifecycle changes to the real daemon.
- The MCP adapter owns initialization, auth, transport/cache, and dynamic
  resource behavior. Native MCP can connect during session startup.

The full installed startup was **not executed**. This measurement deliberately
uses the explicitly labelled controlled subset instead. On the validation machine,
excluded installed extension entrypoints were:

`compact-tools`, `darkweb`, `hooks`, `message-barrel`, `privatemode`,
`sesh-agent-state`, `session-model`, `pi-rpc-socket`, `pi-mcp-adapter`.

Every run discovers and emits the actual excluded entrypoint paths. Native MCP,
`tool-search`, and `llama.cpp` are not loaded. **Even the MCP gateway declaration
is absent**, not just server tool schemas. Deferred MCP metadata/catalogue cost
is therefore unmeasured. Omitted extensions may change context, so these results
are neither default totals nor a proven default-session lower bound; do not add a
source-size correction and claim otherwise. No real browser, MCP transport,
hook, socket server, or lifecycle integration is started.

## How to interpret the measurements

There are three different quantities:

- **Source inventory:** [`audit-context.py`](../scripts/audit-context.py) counts
  files, not assembled requests. This tool also reports instruction/skill source
  sizes without publishing their contents. `localMemory` measures the trimmed
  text the actual agents-local extension includes, not its raw file bytes.
- **Actual controlled SDK request:** `initialRequest.components` measures the
  reconstructed system text, JSON serialization of the current tool declarations,
  and user text received by the fake provider. `componentSum` sums those three
  disjoint representations. `normalizedRequestJson` separately measures the
  entire normalized context object, including JSON structure and metadata; do
  **not** add it to the component sum. Source/catalogue/tool breakdowns are
  subsets or alternate representations, not additional context.
- **Provider billing:** not measured. Real providers serialize role boundaries,
  system sections, and tools differently, use different tokenizers, and report
  cache/input usage according to their own contracts. Fake usage is zero by
  construction, not a claim that a real request costs zero.

All estimates are **Unicode code-point characters / 4**, with no rounding, plus
UTF-8 byte counts. No readily available tokenizer was found for this run, and
none was installed or downloaded. These estimates are not `o200k_base` counts.

`skillCatalogueInActualSystemText` measures the SDK-formatted catalogue/hint text
verified present in the captured system prompt, excluding its outer `<skills>`
wrapper. Initial skill bodies are not expanded. Each skill's
`expandedUserMessage` and `incrementalEstimatedTokensCharsDiv4` come from an
actual fresh `/skill:name` request relative to the same neutral user prompt.
This includes Pi's skill wrapper, base-directory guidance, and frontmatter
removal. It is **not** a hashline `read` tool result, which would add line anchors,
possible truncation, tool-call/result envelopes, and prior conversation.

Skill source-body trimming alone need not reduce the fresh catalogue: catalogue
cost depends on names/descriptions/paths and manual-only flags. The large body
savings appear when a skill is loaded. Source copies in sibling repositories do
not change deployed copies until distribution; rerun after deployment.

## Validation snapshot — pocket4, 2026-10-07

**Controlled profile only; characters/4 estimates, not default-session totals or
provider billing.** Pi **1.0.4**. These initial-request counts were unchanged
between the first capture and the fully deployed four-skill rerun:

| cwd | System text chars | Tool JSON chars | User chars | Component-sum chars/4 |
|---|---:|---:|---:|---:|
| Neutral temporary directory | 18,815 | 8,859 | 49 | 6,930.75 |
| myagent | 27,265 | 8,859 | 49 | 9,043.25 |
| sesh | 28,695 | 8,859 | 49 | 9,400.75 |
| myrig | 28,013 | 8,859 | 49 | 9,230.25 |

Each cwd discovered **21 skills**, advertised **14**, and kept **7 manual-only**.
The catalogue/hint text was **8,218 characters / 2,054.5 estimated tokens**, a
subset of the system-text column. Tool declarations were exactly:
`read`, `bash`, `edit`, `write`, `codemode`, `web_search`, `fetch`.

Actual installed skill expansion increments, **same controlled profile and
characters/4 method**, not billing. Both columns were captured from fresh SDK
requests during this measurement task; the first capture preceded deployment:

| Explicit skill | Before: extra user chars/4 | Deployed: extra user chars/4 | Deployed SKILL.md bytes |
|---|---:|---:|---:|
| sesh-cli | 24,626.5 | 1,719 | 7,129 |
| myvault | 8,393.5 | 2,023.25 | 8,422 |
| mysetup-navigator | 6,029 | 1,765.25 | 7,423 |
| boxyard-cli | 6,462.5 | 1,685.25 | 6,863 |

The catalogue did not change: this deployment saves context **when these skills
are loaded**, not on the neutral fresh request. This is a real before/after for
explicit skill loading only, not a reconstructed pre-global/repository-trim
baseline. Distribution happened between runs; no source body was substituted
for its installed copy.

Two consecutive post-deployment real-SDK runs produced identical request
component/tool and skill measurements: **88 fake requests per run** (four cwds ×
22 fresh sessions), no skill diagnostics. Temporary path names change; lengths
were stable in these runs. Counts can change with SDK versions, absolute path
lengths, installed resources, or concurrent edits. No pre-global/repository-trim
request sample exists: the older figures in [agent-context.md](agent-context.md)
and the repository audit are **source measurements only**, not an actual-request
baseline.

Validation also covered syntax, required labels, invalid-argument rejection,
worker refusal without Node permissions, count-only output fields, and malformed
settings failing without echoing a private sentinel in parser diagnostics.
Real settings/auth/session writes are prevented by the read-only mount and
in-memory stores rather than inferred from a noisy before/after scan of live
sessions that other agents are concurrently updating. Child processes are
forbidden in the worker, and no tool calls occur, so the browser launcher is
never reached. No reload, deployment, paid call, or real service change is part
of measurement.

## Other clients

No Claude/Codex session was launched or measured. Pi SDK results do not measure
their prompt construction, tool discovery, instruction caps, or billing. Use
their documented client-local context displays separately when appropriate;
this bounded tool does not instrument or patch those harnesses.

Implementation references: installed Pi `docs/sdk.md`, `docs/extensions.md`,
`docs/skills.md`, `docs/configuration.md`, `docs/settings.md`,
`docs/custom-provider.md`, and the SDK skills/context/settings examples;
[existing exposure test](../scripts/test-context-exposure.mjs) and
[context policy](agent-context.md).

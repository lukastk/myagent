# MCP servers and browser operations

On-demand reference extracted from the repository guide on 2026-10-07.
Paths in code spans are repository-root-relative unless explicitly qualified;
example paths and installed-home paths are not checkout files.
Dated incidents and validation results are historical observations, not a claim
about every currently installed runtime. Read only for the relevant task.

For current exposure policy and tests, see [agent context](agent-context.md)
and [native codemode / adapter ownership](pi-mcp-codemode.md).
All servers in `mcp.json` use `directTools: "search"`; connection lifecycle is
independent of schema exposure. The incident measurements below predate that
2026-10-07 change; they motivate keeping the gates, isolation and lazy shim.

## MCP servers

MCP server definitions live in `mcp.json` at the repo root. The Pi installer
symlinks it to the shared/Pi config paths; the Claude and Codex installers
translate the same declarations into those clients' user-scoped configs.

Our fork of `pi-mcp-adapter` (declared in `external_extensions.txt`) owns MCP
connections. It reads the shared config and `mcp-adapter.json`; `/mcp-adapter`
is its manager (`/mcp` is an alias while native MCP is disabled). Servers are
lazy and idle-disconnected. `settings.deferWithMissingMetadata: true` also
prevents a cold/stale catalog from spawning servers at startup: discover an
uncached server explicitly with `mcp({ connect: "server-name" })` once. Cached
tools are available to native discovery without reconnecting. `scriptMode:
false` disables the redundant `mcpScript`; use native `codemode` for orchestration.

Historically, local `playwright` used `"directTools": true`; it changed to
`"search"` on 2026-10-07. The adapter supports `true` to promote that server's tools to **direct Pi tools** rather than routing them through the on-demand discovery proxy — they show up as first-class tools without a `/mcp` promote step. This field is Pi-specific: `scripts/install-claude.sh` builds the Claude payload from a whitelist (`command`/`args`/`cwd`/`env` for stdio servers, or `type`/`url`/`transport`/`headers` for url-based remote servers), so `directTools` is naturally dropped for Claude Code.

The `playwright` server is special-cased: instead of an `npx`-spawned server, it runs the `brave-cdp-mcp` launcher in the patched persistent install at `~/.local/playwright-mcp`, fronted by the **lazy shim** (`command: bash`, `args: ["mcp-lazy", "bash", "brave-cdp-mcp"]`, `cwd: ~/.local/playwright-mcp`) that `scripts/install-pi.sh` creates, patches, and links the launchers into. `mcp-lazy` runs the Python `mcp-lazy-shim` when python3 + a warmed cache are present (serving `initialize`/`tools/list` from cache so a non-browsing session holds an ~12 MB shim instead of a ~128 MB Node `cli.js`), and otherwise falls straight through to `brave-cdp-mcp` — see the "Lazy MCP proxy shim" section below. See also the "Per-agent isolated Brave" section and [installation steps](installation-and-settings.md#how-installsh-works).

A second `playwright-main` server runs the **same launcher** with `env: { BRAVE_CDP_REAL: "1" }`, so it connects to the user's real interactive Brave on `:9222` (launched via the `brave-mcp` shell function in myrig) instead of launching an isolated one. It exists so an agent can opt into driving the user's live window (tools namespaced `mcp__playwright-main__*`) without the user restarting the session — both servers are registered from the start; the agent just picks the toolset. It's `directTools: "search"` (like every other declared server, including isolated `playwright`): cached tools use Pi's native `deferred` exposure, discoverable/callable from codemode without adding full declarations to each prompt. Caveat: agents must **not** call `browser_close` on this server — it would close the user's real Brave window (the global browser-usage note in myrig spells this out).

**`:9222` memory gate.** Claude Code and Codex spawn every configured stdio MCP server *eagerly* at session start (only Pi honours `lifecycle: lazy` — both surfaces confirmed to have no lazy stdio option). So a globally-registered `playwright-main` used to leave one resident ~65 MB Node wrapper **per session** attached to a `:9222` that is not running — on a headless box it can never be used, yet under a many-session sweep this dead weight reached multiple GB of swap and took mymain down (2026-08-06). The launcher now **probes the CDP port in `BRAVE_CDP_REAL=1` mode and `exit 0`s before the MCP handshake when nothing is listening** (see "Opt-out / fallback to connect-mode" below), so `playwright-main` costs nothing except when your interactive Brave is actually up. A headless/background agent showing `playwright-main` as *failed* in `/mcp` is the **expected, healthy** state; run `brave-mcp` to bring up `:9222` (then reconnect via `/mcp`) to use it. This gate is a stopgap for the eager-spawn root cause; the durable fix is a lazy proxy shim (a tiny process that answers `initialize`/`tools/list` cheaply and only spawns the heavy Node cli.js on first tool call), which also reclaims the *isolated* `playwright` wrapper for non-browsing sessions.

Two remote servers use the same upstream tool surface on a chosen Mac:

- **`playwright-macstudio`** — the preferred always-on, high-RAM acquisition worker.
- **`playwright-macbook`** — the opt-in laptop worker; it can be asleep/offline.

Both use `directTools: "search"`: cached tools are registered with native Pi
`deferred` exposure and namespace `mcp__<server>`, not eagerly declared.
For example `searchTools("navigate", { namespace: "mcp__playwright-macstudio" })`
inside codemode finds the callable adapter tool names. Their transport and
lifecycle are described under "Remote Playwright workers" below.

### Per-agent isolated Brave (`brave-cdp-mcp`)

Source: `scripts/brave-cdp/brave-cdp-mcp`. Pointing Playwright MCP at one shared Brave over a single CDP endpoint makes every agent grab `browser.contexts()[0]` — the same default context and tab pool — so concurrent agents clobber each other's tabs. The launcher gives **each agent session its own Brave**, using Playwright's **launch mode** (not connect-over-CDP):

- **Default (isolated, launch mode) — macOS *and* Linux with a launchable Brave.** The launcher's `$PPID` *is* the agent process (the MCP server is a direct child of `pi`/`claude` — verified). It seeds a tiny profile at `/tmp/brave-cdp/<agent-pid>` (the encryption key `Local State` + cookie DBs + small prefs/login data — ~1 MB, enough for cookie-based logins like Gmail/GitHub; the real profile's `Extensions/` dir is deliberately **not** linked in — a connected proxy/VPN extension such as "Proton VPN" would impose a proxy the fresh unauthenticated profile can't reach, breaking every real navigation with `ERR_PROXY_CONNECTION_FAILED`, diagnosed 2026-09-23 on macbook), then `exec`s `cli.js --executable-path <Brave> --user-data-dir <profile>` (no `--cdp-endpoint`). Playwright **launches Brave itself, lazily on the first browser tool call**, and **closes it when the MCP server shuts down** (agent exit / stdio EOF). Per-OS specifics:
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

**Historical follow-up note (from the remote-worker rollout, not a new task):** the `brave-mcp` shell function (`home/.myrig/zshenv/coding.sh`) still launches your interactive `:9222` Brave, and the global browser-usage note is in `home/.pi/agent/AGENTS.md`. At that time the sibling-repo note explained only `playwright` and `playwright-main`; update it separately after deployment if the remote worker names should be advertised in every agent session. The current shared rules now route remote/visible browser work to
`~/.config/myagent/reference/browsers.md`; myrig owns that guidance, not this repo.

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

**Isolation.** Each SSH session has its own shell PID. Passing that PID
explicitly is load-bearing: using the shared sshd parent made two clients select
one profile and Brave rejected the second. Every later `exec` preserves the
chosen PID as the outer MCP process, so it stays alive for the entire session and
disappears with the SSH session.

**No connection multiplexing (`SSH_TARGET_NO_MUX=1`).** `remote-playwright-mcp`
sets this before exec'ing `ssh-target`. Multiplexing is an optimisation for many
SHORT connections; this is a single session held open for the whole MCP lifetime
— days, routinely — so it gains nothing from the shared master while occupying
one of the target's `MaxSessions` channels (**default 10**) the entire time. Past
ten, the master refuses every new channel (`Session open refused by peer`) and
*every other* `ssh-target` call to that Mac falls back to its own connection with
alarming stderr, indistinguishable from a broken host.

Measured on mymain 2026-09-22, before this: **22** of these sessions to
macstudio, up to **20 days** old, 5 holding channels and the other **17 already
forced onto their own connections** — which is the proof none of them needed the
master. One connection per agent is the honest cost, paid once per browser rather
than per request.

The opt-out travels in the environment, not argv, so that an older `ssh-target`
ignores it rather than failing with `Unknown machine`. That also means nothing in
the captured argv can prove it was set, so `test-remote-playwright.sh` asserts on
the variable specifically — without that, dropping the line would regress
silently. See myrig's AGENTS.md, "ssh-target".

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

### Wispr Flow (`wispr-flow`) — remote HTTP, OAuth

`https://api.wisprflow.ai/connect/mcp` — Wispr Flow's hosted MCP server, giving
**read-only** access to the Notetaker data: meeting summaries/transcripts and
attendees, Scratchpad notes, tasks, and calendar events. The first `url`-only
(no `command`) entry in `mcp.json`, so it exercises the remote path all three
installers already had: Claude gets `{"type":"http","url":…}` via
`claude mcp add-json`, Codex gets `codex mcp add --url`, and Pi's adapter
auto-detects OAuth for an HTTP server from the URL alone.

**Auth is per-client and interactive — nothing is stored in this repo.** Each
harness keeps its own token in its own credential store, so authorise once per
harness:

- Claude Code — `claude mcp login wispr-flow` (or `/mcp` in a session)
- Codex — `codex mcp login wispr-flow` (`--no-browser` over SSH)
- Pi — `/mcp-auth wispr-flow`

The browser flow needs a **federated** login (Google / Apple / Microsoft / SSO)
and must finish within 5 minutes; Wispr Flow email+password accounts cannot
complete MCP authorization. There is no API key, so no `secret` entry and no
`env` interpolation.

`directTools: "search"` (like all the Playwright servers, including isolated
`playwright`): its tools are registered with Pi's native `deferred` exposure and
found via `searchTools("meeting", { namespace: "mcp__wispr-flow" })` rather than
declared in every prompt. With `deferWithMissingMetadata: true` a cold catalog
means one explicit `mcp({ connect: "wispr-flow" })` before the tools are
discoverable.

### Adding an MCP server

Edit `mcp.json` and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server@latest"],
      "env": { "API_KEY": "${MY_API_KEY}" },
      "lifecycle": "lazy",
      "directTools": "search"
    }
  }
}
```

Then run `./install.sh` and `/reload` in Pi.

### Using MCP tools

Use `mcp({ search: "browser", server: "playwright" })` or native codemode
`searchTools("navigate", { namespace: "mcp__playwright" })`, then call the returned
tool name. For a cold catalog, connect the specific server explicitly first.
Close isolated browsers with `browser_close` when finished; never close
`playwright-main`.

With `pi-mcp-adapter`, use `/mcp` to see server status and available tools. The adapter exposes a proxy tool that discovers MCP tools on-demand, or you can promote frequently-used tools to direct Pi tools via the `/mcp` panel.

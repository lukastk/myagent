# 02 — Remote stdio Playwright worker

**Status:** done (2026-07-31) · client: `mymain` (Debian) · worker:
`macstudio` (macOS, Apple Silicon)

## Question

Can an agent on one of Lukas's machines use the ordinary Playwright MCP tools
while Brave actually runs in an isolated, target-local profile on a chosen
trusted Mac — with no new network service, no copied credentials, clean
lifecycle, useful failures, and support for concurrent clients?

## Result

Yes, with one important identity fix. A tiny stdio wrapper can carry the MCP
byte stream over the existing `ssh-target` path and start the normal patched
Playwright MCP on the target. Tool discovery and tool calls remain entirely
upstream: the transport does not proxy or reimplement a single Playwright tool.

The naïve use of the existing launcher's `$PPID` profile key **collides under
multiplexed SSH**. The production transport must explicitly use the unique
remote command-shell PID (`$$`) as a validated profile owner/liveness key.

## Mac Studio readiness probe

`ssh-target macstudio` from mymain established all prerequisites:

- host `Mac`, user `cij`, home `/Users/cij`, Darwin 24.3.0 arm64;
- target-local Node v24.15.0 from mise;
- Brave at `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`;
- patched `@playwright/mcp` and the installed `brave-cdp-mcp` symlink;
- the same clean myagent revision as mymain (`d129071` at test time);
- an active `gui/<uid>` launchd domain;
- the exact passwordless
  `sudo launchctl asuser <uid> sudo -u <user>` path succeeds.

The browser process observed during the MCP call was descended through that
target-local `launchctl asuser` bridge. Profile paths, target HOME paths, Brave,
Node, and the Playwright installation in the process tree were all Mac Studio
paths. No browser profile, cookie database, keychain material, or literal
credential crossed to mymain.

## Native MCP surface survives SSH unchanged

The ignored experiment client spoke newline-delimited MCP JSON-RPC over this
process chain:

```text
MCP client on mymain
  -> remote-playwright stdio wrapper
  -> ssh-target macstudio (Tailscale/SSH)
  -> target-local brave-cdp-mcp
  -> target-local @playwright/mcp
  -> isolated target-local Brave
```

Observed initialize result:

- negotiated MCP protocol: `2025-06-18`;
- server: `Playwright`, version `1.61.0-alpha-1778188671000`;
- `tools/list`: 23 ordinary upstream Playwright tools, including
  `browser_navigate`, `browser_evaluate`, `browser_tabs`, and
  `browser_take_screenshot`.

There is no schema translation. JSON-RPC stdout and browser results travel
through SSH; launcher diagnostics stay on stderr. The server on the target owns
tool discovery, version negotiation, browser launch, and tool execution.

## Real acquisition-page verification

From mymain, the remote MCP navigated Mac Studio's Brave to
`https://en.wikipedia.org/wiki/Edward_Tufte`. The returned page data contained
the actual `Edward Tufte` heading and statistician/data-visualization content —
not merely an HTTP status. `browser_take_screenshot` also returned 1,083,612
base64 bytes as a normal MCP image result across the SSH stdio transport.

The full acquisition + concurrency + cleanup suite completed in about 11
seconds on its final run. This is empirical evidence that Mac Studio is a usable
always-on acquisition worker now; it cannot prove future uptime, which remains
bounded by that machine's Tailscale/SSH availability.

## The multiplexing collision and the correct identity

### Failed design: inherit `$PPID` after remote `exec`

The first two-client run used the fixed remote command:

```sh
exec "$HOME/.local/playwright-mcp/brave-cdp-mcp"
```

`ssh-target` deliberately enables OpenSSH connection multiplexing. Concurrent
session channels on the shared connection had the same remote sshd parent PID
(`10408` in the failed run), so both launchers selected
`/tmp/brave-cdp/10408`. One Brave launched and the other correctly failed:

> Opening in existing browser session. This usually means that the profile is
> already in use by another instance of Chromium.

This rules out using the multiplexed parent as the remote session identity.

### Prototype proof: keep the per-channel command shell alive

Keeping each remote command shell as the immediate launcher parent made the
existing `$PPID` logic select unique live shell PIDs. The final experiment run
created concurrent profiles:

- `/tmp/brave-cdp/17721` → main Brave PID `17888`;
- `/tmp/brave-cdp/17722` → main Brave PID `17889`.

Both owner PIDs were alive while their MCP servers were active. Session A stayed
on `https://example.com/?remote_session=A`; session B stayed on
`https://www.iana.org/help/example-domains?remote_session=B`. Each tab listing
contained its own marker and not the other's.

### Production decision: explicit validated remote `$$`

Production should not depend on a shell declining a last-command exec
optimization. The fixed remote command will instead set a narrowly named owner
override from its own `$$`, then `exec` the host launcher. `brave-cdp-mcp` will:

1. accept only canonical decimal target-local PID text of at least 2, using
   lexical validation so leading-zero and oversized values never enter shell
   arithmetic;
2. require it to be alive at launch;
3. use it as the `/tmp/brave-cdp/<pid>` profile key;
4. retain the existing `kill -0 <pid>` stale-profile GC.

Because every step after the remote command shell uses `exec`, the same PID
stays alive as the outer MCP/`sudo launchctl asuser` process for the MCP
lifetime. A random token was rejected as the design because it would destroy
the liveness property that makes stale-profile GC safe.

### Production follow-up: explicit owner proven

After rewriting (not copying) the production scripts, the same full probe ran
through the installed client-side `remote-playwright-mcp` and a temporary
Mac-Studio staging of the final production target entry point (including the
lexical PID-validation fix):

- acquisition owner PID `53298` was live for the MCP lifetime, used the
  target-side keychain bridge, returned 1,083,612 screenshot bytes, and
  disappeared on normal disconnect;
- concurrent owners `53542` / `53543` backed distinct profiles and distinct main
  Brave PIDs `53720` / `53719`; both were live during MCP use and reaped after
  disconnect;
- hard-kill owner `53882` and main Brave `54017` disappeared within the cleanup
  bound, and the next launcher reaped the stale profile;
- stderr identified the profile as `(owner pid 53298)` and had no forwarded
  Linux-locale warning, confirming the fixed production command/gate ran.

Focused regression checks also pass leading-zero and 50-digit owner strings to
both the host gate and base launcher. Both reject safely, and the tests assert
that no integer-expression, arithmetic, or range diagnostic reaches stderr.

Mac Studio's original launcher symlink was then restored and the temporary host
entry/staging directory removed. No target repository file was changed.

## Lifecycle results

### Normal disconnect

Closing each MCP client's stdin caused Playwright to dispose its backend and
browser, the target MCP process to exit, the SSH channel to close, and the
per-channel owner PID to disappear. Both concurrent main Brave processes and
all processes referring to their profile paths were gone within the test's
15-second bound.

The small profile directory intentionally remains until a later launch so a
same-owner local agent can reuse it. On a remote connection its owner PID is
dead, so the next `brave-cdp-mcp` startup removes it.

### Hard disconnect

The test launched Brave under profile `/tmp/brave-cdp/18083`, confirmed owner
PID `18083` was live, then sent `SIGKILL` to the mymain-side transport. SSH
channel teardown removed the target browser/MCP process tree and owner PID
within 10 seconds. The next launcher startup reported the old profile reaped.

The documented hard-failure backstops are therefore:

1. normal pipe/SSH channel teardown, including the tested client `SIGKILL`;
2. on every later launch, target-local GC kills processes for numeric profile
   owners that fail `kill -0`, then removes their profile directories;
3. target `/tmp` aging and reboot remain final disk-cleanup backstops.

A true network partition can keep the remote sshd session PID alive until SSH or
the OS detects the dead connection. GC deliberately will not kill a profile
whose owner still passes `kill -0`; doing so would risk killing a live session.
No new daemon is justified for this edge case.

## Architecture decision

Use a **small stdio transport wrapper plus machine-specific MCP
registrations**:

- `playwright-macstudio` invokes the wrapper with fixed target `macstudio`;
- `playwright-macbook` invokes it with fixed target `macbook`;
- both expose the upstream Playwright tools under their server namespace;
- keep both non-direct in Pi so 46 duplicate browser schemas do not enter every
  prompt automatically.

Why not a router MCP with a `machine` argument: the target must be chosen before
MCP initialize because that target's upstream server supplies `tools/list` and
owns the browser backend. A router would have to duplicate or dynamically proxy
every Playwright schema, content block, cancellation, and future protocol
change. It adds code while making the ordinary API less ordinary.

Why not one configurable registration: an environment-selected single server
works mechanically, but an agent cannot choose or switch the target from the
available MCP namespaces without editing config and restarting. Two explicit
registrations make the choice visible and deterministic.

## Target selection and security boundary

The transport accepts only the literal short names `macstudio` and `macbook`.
It passes that separately validated value to `ssh-target`; callers cannot supply
an arbitrary hostname, SSH option, remote path, or remote command. The remote
command is a fixed literal. A disallowed `mymain` test failed before SSH with
exit 64 and:

```text
disallowed target 'mymain' (allowed: macstudio, macbook)
```

The production target-side entry point should preflight Darwin, its exact owner
PID, target HOME, GUI domain, passwordless keychain bridge, Brave, Node,
Playwright MCP, and the local launcher. Missing or incompatible preparation
must exit nonzero with a targeted stderr message before any MCP stdout.

Transport security is the existing Tailscale + SSH host/user/key trust from
`ssh-target`. There is no listening port and no unauthenticated service.

## HOME, versions, installation, and errors

- SSH establishes the configured target user and its real HOME; every profile,
  executable, and install lookup happens there.
- The target's installed `@playwright/mcp` version is authoritative. MCP
  initialize negotiates protocol compatibility and returns the target version.
- A target becomes prepared by running myagent's normal installer there. Mac
  Studio was already prepared. A stale or partial install fails in the explicit
  host preflight rather than falling back to a shared `:9222` browser.
- Offline/asleep allowed targets fail through `ssh-target`'s 10-second connect
  timeout. Unknown/disallowed names fail locally before SSH. Incompatible or
  unprepared targets fail in the host entry point.
- Downloads, output files, and browser-visible local files are target-local.
  Text/image MCP results cross back normally.

## Pi, Claude Code, and Codex integration

- **Pi:** already reads repo `mcp.json` through the installed symlink. The two
  remote registrations fit this path directly; `directTools: false` avoids
  eager duplicate schemas.
- **Claude Code:** `scripts/install-claude.sh` already translates every
  `mcp.json` entry into a user-scope stdio server, including a shell wrapper for
  `cwd`. The new registrations need no Claude-specific protocol code.
- **Codex:** at experiment start, `codex mcp list --json` on mymain returned an
  empty list. Codex does **not** consume myagent's JSON config. The installed
  Codex CLI, desktop app, and IDE share `~/.codex/config.toml` and support stdio
  MCP, so myagent needs a focused Codex MCP install/prune step rather than
  merely documenting a false assumption that the Pi symlink reaches it.

There is no product-level Codex limit here; this is an installer gap in
myagent.

## Deferred / sibling-repo boundary

- `MYRIG_MACHINES` and `ssh-target` remain owned by myrig. Adding another
  browser-worker machine requires a deliberate sibling-repo inventory change;
  this task should not patch myrig.
- Fleet deployment still requires each target to pull the eventual myagent
  change and run its installer. This experiment used the already-installed
  target launcher; production verification may stage only the new entry point
  temporarily before that normal deploy.
- MacBook is an allowed worker but may be asleep/offline. Mac Studio is the
  empirically verified always-on worker and should be the documented default.
- myrig's global browser-usage `AGENTS.md` note currently advertises only the
  local and interactive-main servers. The remote names are present in MCP config
  and documented in myagent, but globally advertising them requires a separate
  sibling-repo documentation change.
- Sites whose authentication lives outside the cheap seeded cookie/login-data
  subset retain the existing local-launcher limitation.

## Artifacts

- `remote-playwright-exp` — ignored allow-listed SSH stdio prototype.
- `mcp_probe.mjs` — ignored raw MCP initialize/tools/call client plus public
  content, screenshot, concurrency, process, lifecycle, and failure assertions.

The experiment code is throwaway. Production scripts must be rewritten from
these findings rather than copied.

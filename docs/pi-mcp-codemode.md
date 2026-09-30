# Pi native code mode with the lifecycle-preserving MCP adapter

Decision: 2026-09-30, tested on mymain with Pi 0.99.1.

## Architecture

Use **native `codemode`**, but retain one MCP connection owner: our
[`lukastk/pi-mcp-adapter` fork](https://github.com/lukastk/pi-mcp-adapter/tree/myagent-codemode).
The integration branch is `myagent-codemode`, based on upstream `c04a24b`
(3.3.0 plus four upstream commits), version `3.3.0-myagent.1`.
Its development checkout is Boxyard box `20260930_vcs2zg__pi-mcp-adapter`.

Why not migrate all MCP to Pi? Native MCP 0.99.1 connects enabled servers at
startup, ignores adapter `lifecycle`/`directTools`, and does not provide the
adapter's idle reclamation. Deferred **tool exposure** is not lazy **connections**.
This matters for many concurrent sesh threads and SSH workers on the Macs.

Baseline tests against adapter 3.3.0 showed that native codemode received strings
from direct MCP tools, and native discovery could not see inactive search-mode
tools. Native Pi handled these correctly but connected the fixture at startup.
The narrow adapter patch fixes the tool boundary without replacing its lifecycle.

## Configuration and ownership

- `pi_settings.json`: `defaultTools: ["+codemode"]`, ordinary tools stay enabled.
- `extensions: ["-builtin:mcp"]`: disable native session MCP explicitly. The newer
  adapter's `/mcp-adapter` no longer reliably replaces native `/mcp` on its own.
- `mcp.json`: shared server declarations; installer links them to
  `~/.config/mcp/mcp.json` and `~/.pi/agent/mcp-adapter.json`.
- `~/.pi/agent/mcp.json` remains linked for explicit `pi mcp ...` CLI diagnostics.
  **Those CLI commands use native MCP and can eagerly connect all four servers.**
- `settings.deferWithMissingMetadata: true`: no automatic connections even with
  a cold/stale catalog. Discover an uncached server explicitly with
  `mcp({ connect: "playwright-macstudio" })`; subsequent sessions use its cache.
  The fork also prevents first-use initialization from bootstrapping unrelated
  lazy servers when the entire cache file is absent.
- `settings.scriptMode: false`: native codemode is the one script tool we expose.
- Local Playwright stays direct; main and both remote workers use
  `directTools: "search"`, mapped to native Pi `deferred` exposure in our fork.

Within codemode:

```js
const matches = await searchTools("navigate", {
  namespace: "mcp__playwright-macstudio",
});
text(matches);
```

Use the returned tool name; namespaces are native-style, but **adapter tool names
have not been renamed**. Direct MCP tool calls resolve to the full public MCP
result (`content`, `structuredContent`, `isError`); top-level app-only `_meta` is
removed. Scripts can filter a large result without inheriting display truncation.
MCP error results are explicit error envelopes. Resource tools retain their text
contract; this is not a claim of complete native MCP feature parity.

`/mcp-adapter` is the manager; `/mcp` remains an alias while native MCP is disabled.
Brave launchers, cookie isolation, keychain bridging, SSH allow-list, and the
local `mcp-lazy` shim are unchanged. Claude/Codex consume only `mcpServers` and
whitelisted transport fields, so Pi-only settings do not change their clients.

## Installer update behavior

`scripts/install-pi-extensions.sh` receives the normalized, deduplicated,
platform-effective source list. For each source it runs:

```sh
pi install --no-approve "$source"
pi update --no-approve "$source"
```

This makes updating explicit rather than relying on reinstall behavior. Pi
0.99.1's install already refreshes some sources, so an old installed version alone
was not proof of an installer bug. Targeted updates respect version pins and
advance configured git branches; they do not update Pi itself, project packages,
undeclared extensions, or the separately patched Playwright server.

The fork and upstream npm adapter are mutually exclusive. After successfully
installing/updating the declared fork, the helper removes any installed
`npm:pi-mcp-adapter` source, including versioned declarations. This is permanent
single-owner policy, not a one-time migration fallback. Other removals still
require `--prune`. Errors stop the installer rather than reporting success.

## Tests and maintenance

- `python3 scripts/test-install-pi-extensions.py`: hermetic argv, pins, source
  selection, failure propagation, replacement, and configuration-ownership tests.
- `bash -n scripts/install-pi.sh scripts/install-pi-extensions.sh`.
- Fork: `npm run typecheck`, `npm run test:public-exports`, `npm run test:native`.
- Native integration uses real Pi/QuickJS/stdio, with a deterministic local model:
  no API credentials. Proves no-spawn cold/warm discovery, structured data,
  approvals/hooks, cancellation, withdrawal, and idle reconnect.
- Final full fork suite: **2,169 passed / 5 failed**. All five failures reproduce
  unmodified upstream with the same host dependencies (one child-startup case,
  four timing-sensitive subprocess-cleanup cases). An earlier run had 2,170
  passes / 4 failures. Details in the fork's `FORK.md`; the full suite is not green.
- Installed runtime: `npm audit --omit=dev` reports **zero vulnerabilities** after
  updating the locked fast-uri dependency to 3.1.8 (GHSA-hrr3-gc8f-f4qj). Dev/test
  dependencies have separate upstream advisories; this is not a zero-audit claim
  for the entire development graph.

Run `./install.sh --pi-only` on each client after pulling; `/reload` existing Pi
sessions. Work on the fork in its Boxyard checkout, never Pi's resettable managed
package checkout. Track upstream security fixes and re-test before merging them.
Upstream v3.0.0 replaced the escapable Node-vm script sandbox and fixed project
trust handling; the fork includes those changes rather than freezing 2.38.0.

## Deployment verification (mymain, 2026-09-30)

Ran `./install.sh --pi-only`, then updated the fork through commit `cc39a2c`.
The live settings have native codemode enabled and builtin MCP disabled. `pi list`
contains the git fork and pi-rpc-socket, with no npm adapter. The three config
symlinks point at this repo's `mcp.json`.

A fresh **real CLI process**, using the live settings/extensions and a deterministic
local provider, exercised native codemode against both local isolated Brave and
`playwright-macstudio`: discovery, connect, navigate, snapshot, and close passed
with structured envelopes. Both isolated browsers were explicitly closed.
Native structured bash also retained `exit_code: 7`. No paid model call was made.
`playwright-main` and MacBook were deliberately not opened. The two Venice
model-pattern warnings printed at CLI startup are unrelated, pre-existing scope
entries; they were not silently removed.

Other machines have **not** been reinstalled by this work. They receive the
configuration/fork on their next myagent install; existing sessions need `/reload`.
Detailed logs are in the fork box's `verification/2026-09-30/` (not committed).

## Primary references

- [Pi announcement, 2026-09-29](https://earendil.com/posts/you-said-no-mcp/)
- [Pi 0.99.1 MCP documentation](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/mcp.md)
- [Pi 0.99.1 tool contracts](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md#tools)
- [Adapter 3.3.0, 2026-09-29](https://github.com/nicobailon/pi-mcp-adapter/releases/tag/v3.3.0)
- [Adapter 3.0.0 security/config changes, 2026-09-27](https://github.com/nicobailon/pi-mcp-adapter/releases/tag/v3.0.0)

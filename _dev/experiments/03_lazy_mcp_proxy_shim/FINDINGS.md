# 03 — Lazy MCP proxy shim

**Status:** built, validated, productionized into `scripts/`, and deployed
(2026-08-06). Prototype code here is the throwaway R&D; the shipped versions are
`scripts/brave-cdp/mcp-lazy` + `scripts/brave-cdp/mcp-lazy-shim`, wired into
`mcp.json` (isolated `playwright` only) and `install-pi.sh` (symlink + cache warm).

## Problem

Claude Code and Codex spawn **every** configured stdio MCP server *eagerly* at
session start, and neither has any lazy/on-demand option (confirmed by empirical
test + source review — see the research below). Only Pi honours
`lifecycle: lazy`. So every Claude/Codex session holds a resident
`@playwright/mcp` Node process whether or not it ever browses.

Measured cost of one such idle `cli.js` (post-reboot, RAM available):
**127.9 MB RSS**. Under memory pressure it gets swapped (the supervisor measured
~62 MB total = ~4 MB RSS + ~58 MB swap per proc across 70 procs). On mymain a
~20-agent sweep plus other sessions pushed the isolated `playwright` class to
~4.4 GB and, together with the inert `playwright-main` class (Layer 1's target),
exhausted the 4 GB swap and thrashed the box into a reboot (2026-08-06), killing
a live client run.

Layer 1 (the `:9222` gate, shipped as commit `0012850`) removed the
`playwright-main` half. This experiment (Layer 2) targets the remaining, harder
half: the **isolated `playwright`** wrapper that every session holds even though
most never browse.

## Root-cause research (both eager, no thrash)

- **Claude Code:** no lazy stdio option; stdio servers block the first turn until
  they initialize (30 s `MCP_TIMEOUT`). A stdio server that exits at startup is
  marked failed **once**, no respawn loop. (Agent SDK MCP docs "Connection
  timing"; MCP reference "Automatic reconnection" — reconnect is HTTP/SSE-only.)
- **Codex CLI 0.146.1:** `McpConnectionSet::new` eagerly spawns every enabled
  server at session init; no `lazy`/`on_demand`/`deferred` field exists. A
  server that exits immediately is marked failed once (`.shared()` one-shot
  startup), retried at most once more only on a config/auth *refresh* — no tight
  loop. (`codex-rs/codex-mcp/src/connection_manager.rs`, `rmcp_client.rs`,
  `config/src/mcp_types.rs`.)

Neither runtime can be made lazy by config → a shim is the only lever short of an
upstream change.

## Design

`mcp-lazy-shim <downstream cmd…>` — a lazy stdio-MCP proxy that sits in front of
the real launcher (`bash brave-cdp-mcp`):

- Answers `initialize`, `tools/list`, `ping` itself from a **cached static
  snapshot** (`cache.json` = the real server's `initialize` result +
  `tools/list` result), spawning **nothing**.
- On the **first request that needs the real server** (a `tools/call`, or
  anything not served from cache), it lazily spawns the downstream, performs a
  private MCP handshake with it (replaying the client's `initialize` params
  under a private id, swallowing the downstream's init response, sending
  `notifications/initialized`), forwards the triggering request, then becomes a
  **transparent full-duplex byte pipe** for the rest of the session.
- **Cache-absent / corrupt → EAGER mode:** spawn downstream immediately and relay
  transparently. Correctness never depends on the cache; laziness is a layer on
  top.
- Runtime: **Python 3** (stdlib only; universal on mac/linux/termux; no build
  step). Idle RSS ~12 MB vs ~128 MB for the Node `cli.js`.

Key correctness details: newline-delimited JSON-RPC (MCP stdio framing); a
`LineReader` retains residual buffered bytes so a LAZY→ACTIVE handoff never drops
pipelined client input; `initialize` echoes the client's negotiated
`protocolVersion`; the private-init id (`_shim_init_`) is swallowed so the client
never sees the re-init; `write_all` guards short pipe writes.

## Results

**Memory (the point):** non-browsing session **127.9 MB → 11.8 MB** (~91% less,
~116 MB/session). And the 12 MB *stays resident* instead of being the 128 MB that
swaps out and thrashes.

**Protocol tests** (`test_protocol.py`, mock downstream) — ALL PASS:
- LAZY: initialize/tools/list/ping served from cache, downstream never spawned.
- ACTIVATE: first `tools/call` spawns downstream exactly once; response comes
  from the real downstream, not the cache.
- PIPELINE: `tools/list` + two `tools/call`s in one burst → list from cache, both
  calls reach downstream in order, single spawn.

**Real `@playwright/mcp` E2E** (`test_real_playwright.py`) — ALL PASS:
- initialize + tools/list (23 tools) served with **no** Node spawned; shim idle
  RSS 11.8 MB.
- first `browser_navigate` activates: Node `cli.js` appears as a child, a real
  headless Brave launches, navigate to example.com returns "Example Domain".
- `browser_close` + EOF tears down cleanly; no leaked `cli.js`/Brave.

**Real agents, temp folders** — the load-bearing checks PASS on both eager
runtimes:
- **Claude** (`test_agents_claude.sh`): idle session sees the tools
  (`mcp__playwright__browser_navigate`) with **no** activation; browsing session
  navigates end-to-end, activating once.
- **Codex** (`test_agents_codex.sh`, isolated `CODEX_HOME`): idle session does
  **not** trip activation (codex stays within initialize+tools/list at startup —
  the key codex-specific unknown); browsing session activates once and returns
  "Example Domain".
- **Pi** (`test_agents_pi.sh`, `pi -p --mcp-config`): idle does not trip
  activation; forced onto the playwright MCP tool it activates once and returns
  "Example Domain". (Pi's *unforced* browse used its own `web` extension for the
  simple page — a runtime tool choice, not a shim issue.)
- (The idle "name your browser tool" answers — Claude's namespaced `mcp__…`,
  Codex's built-in `web.run`, Pi's `playwright_browser_navigate` — are model
  artifacts; tool visibility is proven by the ACTIVE path calling the MCP tool.)

**Production wiring** (`test_production_wiring.py`) — drives the exact command
`sh -c "cd ~/.local/playwright-mcp && exec bash mcp-lazy bash brave-cdp-mcp"` with
no env: the `mcp-lazy` wrapper picks the shim, the shim auto-discovers its sibling
cache, stays lazy (python only, no Node child) for initialize+tools/list, and a
`browser_navigate` activates a real headless Brave (Node `cli.js` appears as the
shim's child). ALL PASS.

## Productionization (shipped)

1. Rewrite `mcp-lazy-shim` into `scripts/brave-cdp/mcp-lazy-shim`; `install-pi.sh`
   symlinks it next to `brave-cdp-mcp` in `~/.local/playwright-mcp`, and warms
   the cache once per install (`mcp-lazy-shim --warm bash brave-cdp-mcp` →
   `~/.local/playwright-mcp/mcp-lazy-cache.json`), so the cache always matches the
   pinned `@playwright/mcp` version.
2. `mcp.json`: wrap the **isolated `playwright`** server command as
   `python3 …/mcp-lazy-shim bash brave-cdp-mcp` with `env.MCP_LAZY_CACHE`.
   `install-claude.sh`/`install-codex.sh` translate it automatically (they carry
   `command`/`args`/`env`).
3. Leave `playwright-main` on Layer 1's `:9222` gate (already ~free when down);
   do **not** shim it (avoids the shim-activates→gate-exits interaction).
4. Smoke-test Pi through the shim before global rollout (Pi is already lazy, so
   low risk, but must be confirmed since `mcp.json` feeds all three surfaces).
5. Deploy like Layer 1: only new sessions pick it up (running tree untouched), so
   the ~4 GB isolated-`playwright` class drains as sessions churn.

## Decisions (resolved 2026-08-06)

- **Scope: isolated `playwright` only.** `playwright-main` stays on Layer 1's
  `:9222` gate (already ~free when down; shimming it would collide with the gate's
  clean-exit on activation).
- **All three runtimes** get it (mcp.json feeds Claude/Codex/Pi); Pi is
  neutral-to-positive and validated.
- **Deployed now**, gradual/tree-safe (only new sessions pick it up; the ~4 GB
  isolated-`playwright` class drains as the sweep churns).
- **Later squeeze (not done):** a compiled (Rust/Go) shim would cut idle ~12 MB →
  ~3 MB, at the cost of a per-platform build in install. Python is the no-build
  default.

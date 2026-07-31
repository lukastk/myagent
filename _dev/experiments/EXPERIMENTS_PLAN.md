# Experiments plan — Playwright browser workers

Throwaway prototyping for the isolated Playwright/Brave launchers and remote
browser workers. The first two experiments brought the macOS per-agent model to
Linux; experiment 02 investigates using a chosen trusted machine as the browser
worker. Each experiment is a numbered subdirectory under `_dev/experiments/`.
The only deliverable is **learnings** — written in each experiment's
`FINDINGS.md`, summarised here. Experiment code is gitignored and should NOT be
copy-pasted into `scripts/`; rewrite once confident.

Status legend: `todo` · `in progress` · `done` · `skipped`.

## Goal & scope (decided 2026-06-04)

The browser launcher `scripts/brave-cdp/brave-cdp-mcp` only implements the
**isolated, seeded, per-agent launch** on macOS. On non-macOS it `exec`s
straight into **connect-mode** (attach to a shared Brave on `:9222`) — so Linux
agents share one browser (tab-clobbering) instead of each getting their own.

**Target: isolation parity only.** Each Linux agent should get its OWN Brave
(its own tabs/profile, lazily launched, auto-closed), matching macOS. We are
**explicitly NOT** solving "logged-in as the user" on Linux (that needs a
cross-platform Mac→Linux cookie migration — out of scope per the 2026-06-04
decision). Login on Linux = whatever the box's own Brave profile already has.

---

## `00_linux_brave_profile_landscape`

**Status:** done (2026-06-04)

**Questions**
- How does Linux Brave encrypt cookies on these boxes (keychain vs portable)?
- Is there a keyring / Secret Service available on a headless box?
- Is the box's Brave profile logged into anything?
- What does `brave-mcp` (the current `:9222` launcher) actually run?

**Deliverable**
- A clear picture of the Linux cookie-crypto landscape that determines whether
  seeding is even portable. Full writeup in
  [`00_linux_brave_profile_landscape/FINDINGS.md`](00_linux_brave_profile_landscape/FINDINGS.md).

**Findings**
- Linux Brave cookies are **`v10` encrypted with `--password-store=basic`** — the
  hardcoded "peanuts" key, **no keychain/keyring**. `os_crypt.encrypted_key` is
  absent from `Local State`; `org.freedesktop.secrets` is not provided. So
  Linux cookies are **portable** (any Brave with `--password-store=basic` reads them).
- This is the **opposite** of macOS (cookies encrypted with the keychain key —
  the reason patch 2 drops `--use-mock-keychain`). Patch 2 is correctly
  Darwin-only, so a Linux-launched Brave keeps the default `--password-store=basic`
  → it will decrypt a seeded profile's cookies **without any keychain dance**.
- `brave-mcp` (myrig `home/.myrig/zshenv/coding.sh`) on Linux runs
  `brave-browser --remote-debugging-port=9222 --password-store=basic` against the
  **default** profile — so the shared `:9222` Brave and any seeded copy use the
  SAME encryption. Seeding should "just work."
- mymain's own profile is **barely logged in** (10 cookies, hosts ~ `autonomy.work`;
  no Google/GitHub) — confirms the user's real logins live on the Macs, hence the
  isolation-only scope.

---

## `01_headless_launch_seed_isolation`

**Status:** done (2026-06-04)

**Questions**
- Does Playwright **launch mode** (not connect) work with Brave **headless** on a
  Linux box with no `DISPLAY`?
- If we seed `/tmp/brave-cdp/<pid>` from `~/.config/BraveSoftware/Brave-Browser`,
  does the launched headless Brave **decrypt the seeded cookies** (i.e. carry the
  box's existing login)?
- Do two concurrent agents get **isolated** browsers (separate profiles/processes,
  no shared default context)?
- Is launch **lazy** (nothing opens until first browser tool call) and
  **auto-closed** on shutdown, as on macOS?

**Deliverable**
- A working Linux launch-mode prototype + the exact set of flags/paths the real
  `brave-cdp-mcp` Linux branch will need. Writeup in
  [`01_headless_launch_seed_isolation/FINDINGS.md`](01_headless_launch_seed_isolation/FINDINGS.md).

**Findings** — **feasible, cleanly.** (full writeup in [`01_…/FINDINGS.md`](01_headless_launch_seed_isolation/FINDINGS.md))
- Headless Brave **launch mode works on Linux** with no DISPLAY; two seeded
  profiles ran **concurrently and isolated** (both exit 0).
- **Seeded cookies decrypt for free**: 9/9 seeded cookies came back with values.
  Because patch 2 is Darwin-only, the Linux launch keeps the default
  `--password-store=basic` = the same "peanuts" key the `v10` cookies use. **No
  keychain/keyring code needed** — the whole macOS keychain problem simply doesn't
  exist on Linux.
- Confirmed main-process flags: `--headless --password-store=basic --no-sandbox`.
  `@playwright/mcp` cli exposes all of `--executable-path / --user-data-dir /
  --headless / --no-sandbox`, so the launcher change is small.
- **Production change** = extend the launcher's "launchable Brave? → launch mode,
  else connect" logic from macOS to Linux (seed from `~/.config/BraveSoftware/...`,
  add `--headless --no-sandbox`). **No `install-pi.sh` change.** Lazy/auto-close
  lifecycle is inherited from the proven macOS launch path — worth one end-to-end
  MCP/sesh smoke test at implementation time.

---

## Goal & scope (decided 2026-07-31)

Let an agent on one trusted machine use the ordinary Playwright MCP tools while
the isolated browser, profile, cookies, and macOS keychain access remain on a
chosen allow-listed machine. Mac Studio is the important always-on acquisition
worker. Reuse the existing SSH trust and local `brave-cdp-mcp`; do not expose a
new unauthenticated service or invent a general remote-execution layer.

## `02_remote_stdio_playwright_worker`

**Status:** done (2026-07-31)

**Questions**
- Can stdio be carried transparently over `ssh-target` so MCP initialize,
  `tools/list`, and Playwright tool calls retain the upstream tool surface?
- Does Mac Studio's remote login environment have the installed Playwright MCP,
  Brave, GUI session, passwordless `launchctl asuser`, and keychain access needed
  by the existing isolated launcher?
- Do two simultaneous remote clients receive distinct profiles, tabs, and Brave
  process trees, and does normal stdio disconnect tear them down?
- What survives a hard-killed client, and does the existing stale-profile GC
  provide a dependable backstop?
- How do disallowed and unprepared targets fail, and what integration shape is
  simplest across Pi, Claude Code, and Codex?

**Deliverable**
- A from-mymain Mac Studio MCP probe covering real public-page content,
  concurrency, lifecycle, and a bad target; a production recommendation. Full
  writeup will live in
  [`02_remote_stdio_playwright_worker/FINDINGS.md`](02_remote_stdio_playwright_worker/FINDINGS.md).

**Findings** — feasible, with an SSH-multiplexing identity fix. Full writeup in
[`02_remote_stdio_playwright_worker/FINDINGS.md`](02_remote_stdio_playwright_worker/FINDINGS.md).

- Transparent SSH stdio negotiated MCP `2025-06-18`, returned the target's
  upstream Playwright server and all 23 ordinary browser tools — no schema proxy.
- From mymain, Mac Studio returned real Edward Tufte page content and a 1.08 MB
  screenshot as normal MCP results.
- **Critical finding:** concurrent multiplexed SSH channels share the same sshd
  parent, so blindly inheriting `$PPID` collided on one profile. The unique
  remote command-shell `$$` must be passed explicitly as a validated decimal
  profile-owner PID; a random token would lose safe `kill -0` GC.
- With distinct live shell owners, two simultaneous sessions used profiles
  `/tmp/brave-cdp/17721` and `/17722`, separate main Brave PIDs, and non-overlapping
  tabs/URLs. Both owner PIDs were live throughout MCP use.
- The final rewritten production path repeated the proof with explicit `$$`
  owners `53542` / `53543`; both were live throughout MCP use and reaped
  afterward.
- Normal disconnect and a hard-killed mymain transport both removed browser/MCP
  processes and owner PIDs within the test bounds; the next launch reaped the
  stale hard-kill profile.
- Mac Studio's target-local GUI domain, passwordless `launchctl asuser` keychain
  bridge, Brave, Node, and patched Playwright install were all ready and used.
- Ship a tiny allow-listed stdio wrapper with machine-specific
  `playwright-macstudio` / `playwright-macbook` registrations. A router MCP would
  needlessly duplicate Playwright's evolving protocol and schemas.
- Pi and Claude already have config/application paths. Codex supports stdio MCP
  but currently receives none of `mcp.json`; add a focused Codex install/prune
  step.

---

## Resolved decisions (2026-06-04)

- **Scope:** isolation-only parity on Linux. NOT solving logged-in-as-user on
  Linux (cross-platform cookie migration is out of scope).
- **Workflow:** experiment code gitignored; `EXPERIMENTS_PLAN.md` + each
  `FINDINGS.md` tracked.
- **SHIPPED** `scripts/brave-cdp/brave-cdp-mcp` (this same commit):
  - **Launch trigger:** launch-mode is now the default whenever a launchable Brave
    exists (macOS *or* Linux); only termux / no-local-Brave falls back to
    connect-mode. `BRAVE_CDP_REAL=1` / `BRAVE_CDP_PORT` remain the connect opt-out.
    Consequence: Linux agents no longer need a pre-running `:9222` Brave.
  - **Headless:** `--headless` (+ `--no-sandbox`) only when non-Darwin AND `DISPLAY`
    is unset (so a Linux desktop still gets a headed window). Override:
    `BRAVE_CDP_HEADLESS=1/0`.
  - **`--no-sandbox`:** coupled with the headless decision (headless cloud/server
    boxes can't run the sandbox). Revisit if a headed-but-containerised Linux box
    ever needs it.
  - **Seed source:** Linux seeds from `~/.config/BraveSoftware/Brave-Browser`
    (same profile `brave-mcp` uses); macOS path unchanged. No `install-pi.sh` change
    (patch 2 stays Darwin-only; default `--password-store=basic` is what we want).
  - **End-to-end verified** on mymain via a real pi sesh: browsed example.com + IGN,
    and proved launch-mode (isolated `/tmp/brave-cdp/<pid>` profile, `--headless=new`,
    no `:9222` connect).

## Resolved decisions (2026-07-31)

- **Experiment tracking:** prototype code remains gitignored; the plan and each
  experiment's `FINDINGS.md` are durable.
- **Security boundary:** use the existing trusted SSH/Tailscale machine path;
  browser profiles, cookies, keychain material, and literal credentials stay on
  the selected worker.
- **Scope:** ordinary Playwright browser tools only. Do not build a speculative
  general remote-execution framework.
- **Representation:** a small transparent stdio wrapper plus separate
  `playwright-macstudio` and `playwright-macbook` MCP registrations; no router.
- **Target allow-list:** exactly `macstudio` and `macbook`; Mac Studio is the
  documented/default acquisition worker.
- **Remote identity:** fixed remote command passes its own decimal `$$` as the
  profile-owner PID. The launcher validates it and keeps PID-based stale GC.
- **Discovery:** the selected target's normal `@playwright/mcp` owns initialize,
  `tools/list`, and calls. Do not duplicate schemas.
- **Agent surfaces:** apply `mcp.json` to Codex as well as the existing Pi and
  Claude paths.

## Still to decide

- *(none for this experiment. Fleet deployment and any future inventory changes
  remain operational follow-up.)*

# Experiments plan — Linux Brave parity (isolation-only)

Throwaway prototyping for bringing the macOS per-agent isolated Brave model to
Linux (mymain, and Linux boxes generally). Each experiment is a numbered
subdirectory under `_dev/experiments/`. The only deliverable is **learnings** —
written in each experiment's `FINDINGS.md`, summarised here. Experiment code is
gitignored and should NOT be copy-pasted into `scripts/`; rewrite once confident.

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

## Resolved decisions (2026-06-04)

- **Scope:** isolation-only parity on Linux. NOT solving logged-in-as-user on
  Linux (cross-platform cookie migration is out of scope).
- **Workflow:** experiment code gitignored; `EXPERIMENTS_PLAN.md` + each
  `FINDINGS.md` tracked.

## Still to decide (for implementation)

- **Launch trigger:** make launch-mode the Linux default, gated on "a launchable
  Brave binary exists" (else connect-mode for termux / no-local-Brave). Keep
  `BRAVE_CDP_REAL=1` / `BRAVE_CDP_PORT` as the connect opt-out. *(Recommended;
  symmetric with macOS. Note: this means Linux agents no longer depend on a
  pre-running `:9222` Brave — a simplification, but a behaviour change to confirm.)*
- **Headless:** always `--headless` on Linux, or only when `DISPLAY` is unset (so a
  Linux *desktop* could get a visible window like macOS)? mymain is headless so
  `--headless` is required there regardless.
- **`--no-sandbox`:** required on mymain (container). Always pass on Linux, or only
  when a sandbox launch fails / when containerised?
- **Seed source:** default profile `~/.config/BraveSoftware/Brave-Browser` (same as
  `brave-mcp`) — confirmed fine. (A dedicated seed profile only matters if we later
  pursue logged-in parity, which is out of scope.)
- **End-to-end check:** prototype the modified launcher and drive it through a real
  sesh on mymain (launch-mode, not connect) before shipping.

# 01 — Headless launch-mode + seeded per-agent isolation on Linux

**Status:** done (2026-06-04) · machine: mymain (Debian 13 cloud, headless, no DISPLAY)

## Question

Can we give a Linux agent the macOS-style isolated Brave — Playwright **launches**
its own headless Brave against a per-agent **seeded** profile — and does it work
(launch headless / decrypt seeded cookies / isolate concurrent agents)?

## Result: yes, cleanly. All four sub-questions are green.

Prototype (`run.sh` + `launch_probe.js`) seeded two `/tmp/brave-cdp-exp/<id>`
profiles from `~/.config/BraveSoftware/Brave-Browser` (Local State + Default/Cookies
+ prefs, Extensions symlinked — same recipe as the macOS launcher) and launched
headless Brave against each **concurrently** via the patched playwright-core
(`launchPersistentContext`, `headless:true`, `chromiumSandbox:false`).

| Sub-question | Result |
|---|---|
| Launch mode + headless on Linux (no DISPLAY) | **Works.** Both instances launched and loaded `example.com`. |
| Seeded cookies **decrypt** | **Works.** `cookies_total=9, cookies_with_value=9` — every seeded cookie came back with a decrypted value (`.autonomy.work`, `.annualdeprivationindex.co.uk`, …). So the box's existing login carries into the isolated Brave. |
| Per-agent isolation | **Works.** Two Braves, two profiles (`/tmp/brave-cdp-exp/1001` and `/1002`), concurrent, both exit 0, no shared default-context clobbering. |
| Correct launch flags | **Confirmed** on the main browser process: `--headless`, `--password-store=basic`, `--no-sandbox` (and a harmless `--use-mock-keychain`). |

## Why cookie-decrypt works for free (the key insight)

The launched Brave keeps Playwright's default **`--password-store=basic`** — because
`install-pi.sh` patch 2 (which strips it) is **Darwin-only**. `--password-store=basic`
makes Brave use the hardcoded "peanuts" key, which is exactly what the seeded
`v10` cookies were encrypted with (Exp 00). So **no keychain/keyring code is
needed on Linux** — the macOS keychain dance has no Linux equivalent and isn't
required. (Even the box's lack of a Secret Service helps: Chromium auto-falls-back
to basic when no keyring is present.)

## Gotchas / notes

- **`--no-sandbox` is required** on this box (container; non-root). Passed via
  `chromiumSandbox:false`. Without it the launch fails. On a non-container Linux
  desktop it may not be needed — treat as "pass on headless/cloud Linux".
- The first `ps`-based flag probe reported `password_store_basic=false` /
  `headless=false`; that was a **parse artifact** (it grabbed a `--type=` renderer
  subprocess). Selecting the line with `--user-data-dir=<profile>` AND no `--type=`
  gave the real flags above. Lesson for any future arg assertions: match the main
  browser process explicitly.
- **Not tested here:** the MCP *lifecycle* (lazy launch on first tool call,
  auto-close on stdio EOF). The prototype called `launchPersistentContext` directly
  rather than the `@playwright/mcp` cli. But that lifecycle is identical to the
  already-working macOS launch path — the only deltas are `--headless --no-sandbox`.
  Recommend one end-to-end MCP/sesh smoke test during implementation.

## What the production change looks like

`@playwright/mcp` cli exposes every flag we need: `--executable-path`,
`--user-data-dir` (already used by the macOS branch), plus `--headless` and
`--no-sandbox`. So the Linux path in `scripts/brave-cdp/brave-cdp-mcp` mirrors the
macOS launch branch:

1. **Generalise the launch trigger.** Today line 55 short-circuits ALL non-Darwin
   to connect-mode. Instead: if a launchable Brave binary exists
   (`brave-browser`/`brave`) → **launch mode**; else (termux, no local Brave) →
   keep **connect-mode** to `:9222`. The macOS branch already has a "Brave not
   found → connect" fallback (lines 61–64) — this just extends that logic to Linux.
2. **Linux brave bin + profile paths:** `BRAVE_BIN=$(command -v brave-browser||command -v brave)`,
   `BASE_PROFILE=~/.config/BraveSoftware/Brave-Browser`, cookie DB at `Default/Cookies`.
3. **Seed** `/tmp/brave-cdp/<PPID>` exactly as macOS does (the seed recipe is
   identical; just the source path differs).
4. **exec** `cli.js --executable-path "$BRAVE_BIN" --user-data-dir "$PROFILE" --headless --no-sandbox "$@"`.
5. Keep `BRAVE_CDP_REAL=1` / `BRAVE_CDP_PORT` as the connect-mode opt-out (e.g. the
   "watch a live Brave" case), symmetric with macOS.

No `install-pi.sh` change needed — patch 2 stays Darwin-only; the default
`--password-store=basic` is what we want on Linux.

## Artifacts

- `run.sh` — seeds two profiles + launches both concurrently (isolation test).
- `launch_probe.js` — launches headless Brave against a seeded profile, asserts
  decryption (`context.cookies()`), browsing, and prints launch flags.

# 00 — Linux Brave profile & cookie-encryption landscape

**Status:** done (2026-06-04) · machine: mymain (Debian 13 cloud, headless, no DISPLAY)

## Question

Before attempting to port the macOS seeded-isolation model to Linux, understand
the Linux cookie-crypto landscape: is seeding even portable, is there a keyring,
and is the box's profile logged in?

## What we found

### Cookie encryption = `v10` / `--password-store=basic` / "peanuts" (portable)

`~/.config/BraveSoftware/Brave-Browser/Default/Cookies` (10 cookies) — every
`encrypted_value` carries the **`v10`** prefix, and:

- `Local State` has **no `os_crypt.encrypted_key`** → Brave is NOT using a
  keyring-derived key.
- `org.freedesktop.secrets` is **not provided** (`secret-tool search` fails: "The
  name org.freedesktop.secrets was not provided by any .service files") — there is
  no GNOME-Keyring / KWallet Secret Service running. `secret-tool` binary exists
  but no daemon. `DBUS_SESSION_BUS_ADDRESS` is set (`/run/user/1000/bus`) but no
  secrets provider on it.

On Linux, `v10` + no keyring ⇒ cookies are encrypted with the **hardcoded
"peanuts" key** (`PBKDF2(b"peanuts", b"saltysalt", iterations=1, ...)`, AES-128-CBC).
That key is identical on every machine → **Linux cookies are portable**: any
Brave launched with `--password-store=basic` can read a copied profile's cookies.

### This is the inverse of macOS

macOS Brave cookies are also `v10`-prefixed, but the key comes from the
**macOS keychain** ("Brave Safe Storage"). That's why `scripts/install-pi.sh`
patch 2 **drops** `--use-mock-keychain` / `--password-store=basic` on macOS — so
the launched Brave uses the real keychain key instead of a mock one.

Crucially, **patch 2 is Darwin-only**. On Linux the launched Brave keeps
Playwright's default `--password-store=basic` switch, which is *exactly* what we
want — it makes the launched Brave use the same peanuts key the seeded cookies
were encrypted with. So **no keychain/keyring machinery is needed on Linux**; the
seed-and-decrypt should work for free.

### `brave-mcp` already uses basic store

`brave-mcp` (myrig `home/.myrig/zshenv/coding.sh:29`) on Linux runs:

```
setsid -f brave-browser --remote-debugging-port=9222 --password-store=basic "$@"
```

against the **default** profile. So the shared `:9222` Brave the current
connect-mode attaches to, the on-disk profile, and any seeded copy all share the
same `--password-store=basic` encryption. Consistent end to end.

### The box's profile is barely logged in

10 cookies across 5 hosts — `.autonomy.work` / `autonomy.work` plus
`annualdeprivationindex.co.uk`, `spotlightcorruption.org`. **No Google, no
GitHub.** Confirms the user's real logins live on the Macs, not here — which is
why the agreed scope is **isolation-only** (don't try to make Linux "logged in as
you"; that needs a Mac→Linux cookie migration across the keychain→peanuts boundary).

## Implications for production design

1. The Linux launch branch can seed a profile and rely on Playwright's **default
   `--password-store=basic`** to decrypt it — no keychain/keyring code, no extra
   patch. (Contrast macOS, which needed patch 2.)
2. Seeding mechanics mirror macOS but with Linux paths: source
   `~/.config/BraveSoftware/Brave-Browser`, cookie DB at `Default/Cookies`
   (this box has no `Default/Network/Cookies`).
3. "Logged-in as the user" is explicitly out of scope; the isolated Linux Brave
   inherits whatever the box profile has.

## Artifacts

Pure recon — no code. Probes used: `python3` sqlite read of the Cookies DB
(no `sqlite3` CLI on the box), `Local State` JSON inspection, `secret-tool search`.

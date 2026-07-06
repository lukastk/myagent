---
name: android-control
description: Control Lukas's Android phone (Pixel 9, Tailscale host `android-main`) remotely from a machine with adb, over Tailscale — no USB. Use to launch/force-stop apps, take screenshots, send input, and especially to test Obsidian mobile (cold-start timing, JS-eval inside the Obsidian WebView via CDP). Use when Lukas asks to test something on his phone, screenshot the phone, drive the Android Obsidian app, or measure mobile startup. Also covers first-time wireless-debugging pairing.
---

# android-control

Drive Lukas's Android phone from a remote machine (e.g. `mymain`) over **Tailscale**, using `adb` wireless debugging. No USB cable is ever needed — the phone and the controlling machine share a tailnet.

## Device facts

- Phone: **Pixel 9**, Android 16, Tailscale host **`android-main`**, Tailscale IP **`100.67.70.114`**.
- Obsidian package: **`md.obsidian`**.
- Controlling machine needs `adb` (`sudo apt-get install -y adb`). `scrcpy` optional for screen mirroring.

## 1. First-time pairing (only once per machine)

Android 11+ wireless debugging requires a one-time pairing. On the **phone**:

1. Settings → Developer options → **Wireless debugging** → ON.
2. Tap **"Pair device with pairing code"** → it shows a **6-digit code** and an `IP:port`.
3. The main Wireless-debugging screen also shows a *different* **"IP address & Port"** — that's the **connect** port.

The pairing dialog usually shows the Tailscale IP directly (`100.67.70.114:<pairport>`). From the controlling machine:

```bash
adb pair 100.67.70.114:<pairport> <6-digit-code>     # one-time; pairing persists
adb connect 100.67.70.114:<connectport>              # the main-screen port
adb devices -l                                        # confirm: "device ... model:Pixel_9"
```

If the pairing dialog shows a LAN IP instead of the Tailscale one, substitute `100.67.70.114` for the host and keep the port — adb's daemon listens on all interfaces, so the Tailscale IP works.

## 2. Reconnecting (the common case — pairing already done)

The ports **rotate** when wireless debugging restarts, and the device goes **offline when the phone dozes** (screen off). So most sessions start with a reconnect:

```bash
adb connect 100.67.70.114:<connectport> && adb devices
```

If it says `offline` or `connection refused`:
- Ask Lukas for the **current** "IP address & Port" from the Wireless-debugging screen (the connect port likely changed).
- Have him enable **Developer options → "Stay awake"** and keep the phone **on the charger** so it doesn't doze mid-session — otherwise the connection drops repeatedly.
- Re-`adb connect` with the fresh port. Pairing does **not** need to be redone.

`mDNS` discovery (`adb mdns services`) does **not** traverse Tailscale — always connect by IP:port.

## 3. Basic control

```bash
adb shell pidof md.obsidian                                   # is Obsidian running?
adb shell monkey -p md.obsidian -c android.intent.category.LAUNCHER 1   # launch it
adb shell am force-stop md.obsidian                           # kill it (for a true cold start)
adb exec-out screencap -p > /tmp/phone.png                    # screenshot → view with the Read tool
adb shell input tap <x> <y>                                   # tap
adb shell input swipe <x1> <y1> <x2> <y2> <ms>                # swipe/scroll
adb shell input text 'hello'                                  # type
```

## 4. JS-eval inside the Obsidian WebView (CDP) — the powerful one

Obsidian mobile is a WebView that exposes a Chrome DevTools socket, so you can run JS in the running plugin context — the mobile equivalent of desktop `obsidian eval` (which is flaky/segfaults on headless mymain). This reaches `app`, `globalThis.ms`, `globalThis.obako`, etc.

```bash
# 1. Find Obsidian's pid and forward its devtools socket to a local port.
PID=$(adb shell pidof md.obsidian)
adb shell cat /proc/net/unix | grep "webview_devtools_remote_${PID}"   # confirm the socket exists
adb forward tcp:9222 localabstract:webview_devtools_remote_${PID}

# 2. List targets (the "page" target is the Obsidian window):
curl -s http://localhost:9222/json | python3 -c "import sys,json;[print(p['type'],p.get('title','')[:40],p.get('webSocketDebuggerUrl','')) for p in json.load(sys.stdin)]"

# 3. Eval JS with the helper (Node 24+, uses the global WebSocket):
node cdp-eval.mjs "app.vault.getName()"
node cdp-eval.mjs "({hasMs: typeof globalThis.ms, notes: [...ms.vault.cache.activeEntries()].length})"
node cdp-eval.mjs "(async()=>{ /* any async expr; result is awaited + JSON-returned */ })()"
```

`cdp-eval.mjs` (in this skill dir) connects to the page target and runs `Runtime.evaluate` with `awaitPromise + returnByValue`. Re-run `adb forward` after a reconnect (the pid/socket change).

Note: the `adb forward` must be re-established after every reconnect, and the pid changes if Obsidian is force-stopped/relaunched — re-probe the socket each time.

## 5. Cold-start testing for mysystem-obsidian

mysystem's cache-snapshot work has cold-start timing instrumentation. To measure on the real device:

1. Enable the timing notice: in Obsidian settings, turn on **"Log cold-start timing"** (`cache.debug_startup_timing`), or read it via CDP `console`.
2. `adb shell am force-stop md.obsidian` (guarantees a true cold start, not a warm resume).
3. Relaunch, open a note, and read the timing — either the in-app Notice (screenshot it) or via CDP. The plugin logs: index "hydrated from snapshot" vs "cold build" in Xms, and the Obsidian metadata floor (onload→resolved) in Yms.
4. Repeat ~5× and take the median (mobile variance is high). The snapshot file lives at `<vault>/.obsidian/plugins/mysystem-obsidian/cache-snapshot.json.gz`.

To deploy a new plugin build to the phone: it propagates via Obsidian Sync if community-plugin sync is on; otherwise the build must reach the phone's vault by whatever sync Lukas uses (the Android app sandbox makes direct `adb push` into the app's data dir infeasible without root).

## 6. scrcpy (optional, for live viewing/control)

```bash
scrcpy --tcpip=100.67.70.114:<connectport>     # mirror + control the screen
```

## Gotchas

- **Doze drops the connection** and rotates the port → "Stay awake" + charger, and reconnect with the fresh port.
- **Pairing persists**, connect ports don't.
- **mDNS doesn't work over Tailscale** — always IP:port.
- `run-as md.obsidian` fails ("package not debuggable") — that's fine; the **WebView** devtools socket is still exposed, which is all CDP needs.
- Don't leave `adb forward` rules dangling across pid changes; `adb forward --remove-all` to reset.

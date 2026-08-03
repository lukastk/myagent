#!/usr/bin/env bash
set -euo pipefail

# This file doubles as the fake ssh-target / node executables when reached through
# the test symlinks. Arguments are line-safe here: both are fixed production values.
# The capture path is derived from $0 rather than passed in the environment: on
# macOS the launcher execs the runner through `sudo … launchctl asuser`, and sudo
# strips any env var the test would have set.
case "${0##*/}" in
    ssh-target|runner)
        printf '%s\n' "$@" > "$0.capture"
        exit 0
        ;;
    uname)
        echo "TestOS"
        exit 0
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT="$SCRIPT_DIR/remote-playwright-mcp"
HOST="$SCRIPT_DIR/remote-playwright-host"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp_dir="$(mktemp -d)"
local_profile="/tmp/brave-cdp/$$"
cleanup() {
    rm -rf "$tmp_dir"
    rm -rf "$local_profile"
    if [ -n "${gc_decoy_pid:-}" ]; then
        kill "$gc_decoy_pid" 2>/dev/null || true
    fi
    if [ -n "${gc_dead_profile:-}" ]; then
        rm -rf "$gc_dead_profile"
    fi
}
trap cleanup EXIT

# A stand-in for the Brave binary. Built here rather than symlinked to /bin/true,
# which does not exist on macOS — a dangling link is not -x, so the launcher took
# its "no launchable Brave" connect path and skipped every isolated-launch check.
fake_brave="$tmp_dir/fake-brave"
printf '#!/bin/sh\nexit 0\n' > "$fake_brave"
chmod +x "$fake_brave"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_status() {
    expected="$1"
    actual="$2"
    label="$3"
    [ "$actual" -eq "$expected" ] || fail "$label: expected exit $expected, got $actual"
}

run_failure() {
    output_file="$1"
    shift
    set +e
    "$@" >"$output_file.stdout" 2>"$output_file.stderr"
    command_status=$?
    set -e
}

ln -s "$SCRIPT_DIR/$(basename "$0")" "$tmp_dir/ssh-target"
capture="$tmp_dir/ssh-target.capture"
PATH="$tmp_dir:/usr/bin:/bin" bash "$CLIENT" macstudio

line_count="$(wc -l < "$capture" | tr -d ' ')"
[ "$line_count" -eq 2 ] || fail "expected machine plus one fixed remote command"
ssh_machine="$(sed -n '1p' "$capture")"
ssh_remote_command="$(sed -n '2p' "$capture")"
[ "$ssh_machine" = "macstudio" ] || fail "wrong ssh-target machine: $ssh_machine"
expected_remote='exec env LC_ALL=C BRAVE_CDP_PROFILE_OWNER_PID=$$ "$HOME/.local/playwright-mcp/remote-playwright-host"'
[ "$ssh_remote_command" = "$expected_remote" ] || fail "remote command changed: $ssh_remote_command"

rm -f "$capture"
run_failure "$tmp_dir/disallowed" env PATH="$tmp_dir:/usr/bin:/bin" \
    bash "$CLIENT" mymain
assert_status 64 "$command_status" "disallowed target"
grep -Fq "disallowed target 'mymain'" "$tmp_dir/disallowed.stderr" \
    || fail "disallowed-target error is not useful"
[ ! -e "$capture" ] || fail "disallowed target reached ssh-target"

run_failure "$tmp_dir/missing-ssh" env PATH="/usr/bin:/bin" bash "$CLIENT" macstudio
assert_status 69 "$command_status" "missing ssh-target"
grep -Fq "ssh-target is not installed" "$tmp_dir/missing-ssh.stderr" \
    || fail "missing-ssh-target error is not useful"

run_failure "$tmp_dir/missing-owner" env -u BRAVE_CDP_PROFILE_OWNER_PID bash "$HOST"
assert_status 64 "$command_status" "missing owner PID"
grep -Fq "must be a canonical decimal remote command-shell PID" "$tmp_dir/missing-owner.stderr" \
    || fail "missing-owner error is not useful"

run_failure "$tmp_dir/wrong-owner" env BRAVE_CDP_PROFILE_OWNER_PID=999999 bash "$HOST"
assert_status 64 "$command_status" "wrong owner PID"
grep -Fq "is not this remote MCP process" "$tmp_dir/wrong-owner.stderr" \
    || fail "wrong-owner error is not useful"

huge_pid=99999999999999999999999999999999999999999999999999
for entrypoint in host launcher; do
    if [ "$entrypoint" = host ]; then
        entrypoint_command=(bash "$HOST")
    else
        entrypoint_command=(env BRAVE_CDP_BRAVE_BIN="$fake_brave" bash "$SCRIPT_DIR/brave-cdp-mcp")
    fi

    run_failure "$tmp_dir/$entrypoint-leading-zero" env \
        BRAVE_CDP_PROFILE_OWNER_PID=0002 "${entrypoint_command[@]}"
    assert_status 64 "$command_status" "$entrypoint leading-zero owner PID"
    grep -Fq "canonical decimal" "$tmp_dir/$entrypoint-leading-zero.stderr" \
        || fail "$entrypoint did not reject a noncanonical leading-zero PID"

    run_failure "$tmp_dir/$entrypoint-huge" env \
        BRAVE_CDP_PROFILE_OWNER_PID="$huge_pid" "${entrypoint_command[@]}"
    if [ "$entrypoint" = host ]; then
        assert_status 64 "$command_status" "host oversized owner PID"
    else
        assert_status 70 "$command_status" "launcher oversized owner PID"
    fi

    if grep -Eqi "integer expression|arithmetic|number out of range" \
        "$tmp_dir/$entrypoint-leading-zero.stderr" "$tmp_dir/$entrypoint-huge.stderr"; then
        fail "$entrypoint leaked a shell arithmetic diagnostic for caller-influenced PID text"
    fi
done

# exec preserves bash -c's PID. Reaching the mocked OS check on any host
# proves the explicit owner was decimal, equal to $$, and live.
ln -s "$SCRIPT_DIR/$(basename "$0")" "$tmp_dir/uname"
run_failure "$tmp_dir/incompatible" bash -c \
    'export BRAVE_CDP_PROFILE_OWNER_PID=$$; export PATH="$2"; exec bash "$1"' \
    _ "$HOST" "$tmp_dir:/usr/bin:/bin"
assert_status 69 "$command_status" "incompatible target OS"
grep -Fq "incompatible target OS 'TestOS'" "$tmp_dir/incompatible.stderr" \
    || fail "valid live owner did not reach the target-compatibility check"

# The ordinary local server supplies no override. Prove the launcher still uses
# its direct agent parent as the profile owner and forwards that profile to the
# normal Playwright launch command.
base_profile="$tmp_dir/home/.config/BraveSoftware/Brave-Browser"
mkdir -p "$base_profile/Default/Network"
printf '{}\n' > "$base_profile/Local State"
ln -s "$SCRIPT_DIR/$(basename "$0")" "$tmp_dir/runner"
runner_capture="$tmp_dir/runner.capture"
HOME="$tmp_dir/home" \
    BRAVE_CDP_BRAVE_BIN="$fake_brave" \
    BRAVE_CDP_CLI="$tmp_dir/fake-cli.js" \
    BRAVE_CDP_RUNNER="$tmp_dir/runner" \
    BRAVE_CDP_HEADLESS=1 \
    bash "$SCRIPT_DIR/brave-cdp-mcp"
[ -d "$local_profile/Default" ] || fail "local launcher did not use its agent parent PID profile"
grep -Fxq -- "$local_profile" "$runner_capture" \
    || fail "local profile was not forwarded to the Playwright launch command"

# Profile GC must be exact about which browser it reaps. `pkill -f` matches an
# extended regex against the whole command line, so cleaning up dead owner 3674
# once also killed a LIVE browser running with --user-data-dir=…/brave-cdp/36745.
# Stand up that exact shape: a dead owner's profile dir, plus a live process whose
# profile path merely extends that PID.
bash -c 'exit 0' &
dead_owner=$!
wait "$dead_owner" 2>/dev/null || true
gc_dead_profile="/tmp/brave-cdp/$dead_owner"
mkdir -p "$gc_dead_profile"
bash -c 'exec bash -c "while :; do sleep 1; done" brave-cdp-gc-decoy "$1"' \
    _ "--user-data-dir=/tmp/brave-cdp/${dead_owner}9" &
gc_decoy_pid=$!

HOME="$tmp_dir/home" \
    BRAVE_CDP_BRAVE_BIN="$fake_brave" \
    BRAVE_CDP_CLI="$tmp_dir/fake-cli.js" \
    BRAVE_CDP_RUNNER="$tmp_dir/runner" \
    BRAVE_CDP_HEADLESS=1 \
    bash "$SCRIPT_DIR/brave-cdp-mcp"

[ ! -d "$gc_dead_profile" ] || fail "GC did not remove the dead owner's profile"
kill -0 "$gc_decoy_pid" 2>/dev/null \
    || fail "GC killed a live browser whose profile path only extends the dead owner PID"
kill "$gc_decoy_pid" 2>/dev/null || true
gc_decoy_pid=""
gc_dead_profile=""

python3 - "$REPO_ROOT/mcp.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    servers = json.load(config_file)["mcpServers"]

for machine in ("macstudio", "macbook"):
    name = f"playwright-{machine}"
    cfg = servers[name]
    assert cfg["args"] == ["remote-playwright-mcp", machine]
    assert cfg["directTools"] is False
PY

echo "PASS: remote Playwright transport/unit checks"

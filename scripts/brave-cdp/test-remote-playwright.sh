#!/usr/bin/env bash
set -euo pipefail

# This file doubles as the fake ssh-target executable when reached through the
# test symlink. Arguments are line-safe here: both are fixed production values.
case "${0##*/}" in
    ssh-target)
        : "${REMOTE_PLAYWRIGHT_TEST_CAPTURE:?}"
        printf '%s\n' "$@" > "$REMOTE_PLAYWRIGHT_TEST_CAPTURE"
        exit 0
        ;;
    runner)
        : "${REMOTE_PLAYWRIGHT_TEST_CAPTURE:?}"
        printf '%s\n' "$@" > "$REMOTE_PLAYWRIGHT_TEST_CAPTURE"
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
}
trap cleanup EXIT

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
capture="$tmp_dir/ssh-args"
REMOTE_PLAYWRIGHT_TEST_CAPTURE="$capture" PATH="$tmp_dir:/usr/bin:/bin" \
    bash "$CLIENT" macstudio

line_count="$(wc -l < "$capture" | tr -d ' ')"
[ "$line_count" -eq 2 ] || fail "expected machine plus one fixed remote command"
ssh_machine="$(sed -n '1p' "$capture")"
ssh_remote_command="$(sed -n '2p' "$capture")"
[ "$ssh_machine" = "macstudio" ] || fail "wrong ssh-target machine: $ssh_machine"
expected_remote='exec env LC_ALL=C BRAVE_CDP_PROFILE_OWNER_PID=$$ "$HOME/.local/playwright-mcp/remote-playwright-host"'
[ "$ssh_remote_command" = "$expected_remote" ] || fail "remote command changed: $ssh_remote_command"

rm -f "$capture"
run_failure "$tmp_dir/disallowed" env \
    REMOTE_PLAYWRIGHT_TEST_CAPTURE="$capture" PATH="$tmp_dir:/usr/bin:/bin" \
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
        entrypoint_command=(env BRAVE_CDP_BRAVE_BIN=/bin/true bash "$SCRIPT_DIR/brave-cdp-mcp")
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
ln -s /bin/true "$tmp_dir/fake-brave"
ln -s "$SCRIPT_DIR/$(basename "$0")" "$tmp_dir/runner"
runner_capture="$tmp_dir/runner-args"
REMOTE_PLAYWRIGHT_TEST_CAPTURE="$runner_capture" \
    HOME="$tmp_dir/home" \
    BRAVE_CDP_BRAVE_BIN="$tmp_dir/fake-brave" \
    BRAVE_CDP_CLI="$tmp_dir/fake-cli.js" \
    BRAVE_CDP_RUNNER="$tmp_dir/runner" \
    BRAVE_CDP_HEADLESS=1 \
    bash "$SCRIPT_DIR/brave-cdp-mcp"
[ -d "$local_profile/Default" ] || fail "local launcher did not use its agent parent PID profile"
grep -Fxq -- "$local_profile" "$runner_capture" \
    || fail "local profile was not forwarded to the Playwright launch command"

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

#!/usr/bin/env bash
set -euo pipefail

# This file doubles as the fake Codex CLI when reached through the test symlink.
if [ "$(basename "$0")" = "codex" ]; then
    : "${CODEX_INSTALL_TEST_CAPTURE:?}"
    {
        first=true
        for arg in "$@"; do
            if [ "$first" = true ]; then
                first=false
            else
                printf '\t'
            fi
            printf '%s' "$arg"
        done
        printf '\n'
    } >> "$CODEX_INSTALL_TEST_CAPTURE"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

tmp_dir="$(mktemp -d)"
cleanup() {
    rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

mkdir -p "$tmp_dir/repo/scripts" "$tmp_dir/repo/.install-state" "$tmp_dir/bin" "$tmp_dir/home"
cp "$SCRIPT_DIR/install-codex.sh" "$tmp_dir/repo/scripts/install-codex.sh"
cp "$REPO_ROOT/mcp.json" "$tmp_dir/repo/mcp.json"
ln -s "$SCRIPT_DIR/$(basename "$0")" "$tmp_dir/bin/codex"

capture="$tmp_dir/codex-calls"
python_bin="$(command -v python3)"
test_path="$tmp_dir/bin:$(dirname "$python_bin"):/usr/bin:/bin"
CODEX_INSTALL_TEST_CAPTURE="$capture" HOME="$tmp_dir/home" \
    PATH="$test_path" \
    bash "$tmp_dir/repo/scripts/install-codex.sh" >/dev/null

state="$tmp_dir/repo/.install-state/codex_mcp.txt"
for name in playwright playwright-main playwright-macstudio playwright-macbook; do
    grep -Fxq "$name" "$state" || fail "Codex state is missing $name"
done

grep -Fq $'mcp\tadd\tplaywright-macstudio\t--\tsh\t-c\tcd '"$tmp_dir/home"'/.local/playwright-mcp && exec bash remote-playwright-mcp macstudio' "$capture" \
    || fail "Mac Studio stdio/cwd mapping was not applied to Codex"
grep -Fq $'mcp\tadd\tplaywright-main\t--env\tBRAVE_CDP_REAL=1\t--\tsh\t-c' "$capture" \
    || fail "Playwright-main environment was not applied to Codex"

printf '%s\n' old-myagent-server >> "$state"
: > "$capture"
CODEX_INSTALL_TEST_CAPTURE="$capture" HOME="$tmp_dir/home" \
    PATH="$test_path" \
    bash "$tmp_dir/repo/scripts/install-codex.sh" --prune >/dev/null

grep -Fq $'mcp\tremove\told-myagent-server' "$capture" \
    || fail "Codex prune did not remove the stale managed server"
if grep -Fxq old-myagent-server "$state"; then
    fail "Codex prune left the stale server in managed state"
fi

echo "PASS: Codex MCP installer checks"

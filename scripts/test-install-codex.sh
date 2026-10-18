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

    # Stands in for config.toml: a name counts as registered if the scenario
    # pre-registered it, or if an add in this run wrote it.
    #   CODEX_INSTALL_TEST_REGISTERED   - already in config before the run
    #   CODEX_INSTALL_TEST_OAUTH_FAILS  - add writes the entry, then exits 1 on
    #                                     the OAuth step (the real wispr-flow)
    #   CODEX_INSTALL_TEST_ADD_FAILS    - add exits 1 having written nothing
    if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then
        printf '%s\n' "${CODEX_INSTALL_TEST_REGISTERED:-}" | grep -Fxq -- "${3:-}" && exit 0
        if [ -n "${CODEX_INSTALL_TEST_WROTE:-}" ] && [ -f "$CODEX_INSTALL_TEST_WROTE" ]; then
            grep -Fxq -- "${3:-}" "$CODEX_INSTALL_TEST_WROTE" && exit 0
        fi
        exit 1
    fi
    if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ]; then
        if printf '%s\n' "${CODEX_INSTALL_TEST_OAUTH_FAILS:-}" | grep -Fxq -- "${3:-}"; then
            [ -n "${CODEX_INSTALL_TEST_WROTE:-}" ] && printf '%s\n' "${3:-}" >> "$CODEX_INSTALL_TEST_WROTE"
            echo "Error: timed out waiting for OAuth callback" >&2
            exit 1
        fi
        if printf '%s\n' "${CODEX_INSTALL_TEST_ADD_FAILS:-}" | grep -Fxq -- "${3:-}"; then
            exit 1
        fi
    fi
    if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "remove" ]; then
        if [ -n "${CODEX_INSTALL_TEST_WROTE:-}" ] && [ -f "$CODEX_INSTALL_TEST_WROTE" ]; then
            grep -Fxv -- "${3:-}" "$CODEX_INSTALL_TEST_WROTE" > "$CODEX_INSTALL_TEST_WROTE.tmp" || true
            mv "$CODEX_INSTALL_TEST_WROTE.tmp" "$CODEX_INSTALL_TEST_WROTE"
        fi
    fi
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

# wispr-flow is declared interactiveAuth. When its add fails on the OAuth step but
# the entry landed, the install must carry on rather than abort.
: > "$capture"
CODEX_INSTALL_TEST_CAPTURE="$capture" HOME="$tmp_dir/home" \
    PATH="$test_path" \
    CODEX_INSTALL_TEST_OAUTH_FAILS="wispr-flow" \
    CODEX_INSTALL_TEST_WROTE="$tmp_dir/wrote-1" \
    bash "$tmp_dir/repo/scripts/install-codex.sh" >"$tmp_dir/oauth-ok.out" 2>&1 \
    || fail "OAuth timeout on an interactiveAuth server aborted the install"
grep -Fq "codex mcp login wispr-flow" "$tmp_dir/oauth-ok.out" \
    || fail "install did not point at codex mcp login for the pending authorization"

# The same failure on a server that did NOT land must still be fatal.
: > "$capture"
if CODEX_INSTALL_TEST_CAPTURE="$capture" HOME="$tmp_dir/home" \
    PATH="$test_path" \
    CODEX_INSTALL_TEST_ADD_FAILS="wispr-flow" \
    CODEX_INSTALL_TEST_WROTE="$tmp_dir/wrote-2" \
    bash "$tmp_dir/repo/scripts/install-codex.sh" >/dev/null 2>&1; then
    fail "a failed add that registered nothing was not fatal"
fi

# An already-registered interactiveAuth server must not be removed and re-added,
# which would discard the token Codex holds for it.
: > "$capture"
CODEX_INSTALL_TEST_CAPTURE="$capture" HOME="$tmp_dir/home" \
    PATH="$test_path" \
    CODEX_INSTALL_TEST_REGISTERED="wispr-flow" \
    bash "$tmp_dir/repo/scripts/install-codex.sh" >/dev/null 2>&1 \
    || fail "install failed with wispr-flow already registered"
if grep -Fq $'mcp\tremove\twispr-flow' "$capture"; then
    fail "install removed an already-registered interactiveAuth server"
fi
if grep -Fq $'mcp\tadd\twispr-flow' "$capture"; then
    fail "install re-added an already-registered interactiveAuth server"
fi
grep -Fq $'mcp\tadd\tplaywright-main' "$capture" \
    || fail "skipping wispr-flow also skipped the ordinary servers"

echo "PASS: Codex MCP installer checks"

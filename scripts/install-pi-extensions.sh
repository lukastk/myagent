#!/usr/bin/env bash
# Reconcile the declared sources, not every package a user/project happens to have.
# Input is install-pi.sh's normalized, platform-filtered list (one source per line).
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Usage: install-pi-extensions.sh <normalized-source-list>" >&2
    exit 64
fi

while IFS= read -r source <&3 || [ -n "$source" ]; do
    [ -n "$source" ] || continue
    echo "    $source (install + update)"
    # Do not let trusted .pi/settings.json packages join a global rig install.
    pi install --no-approve "$source"
    pi update --no-approve "$source"
done 3< "$1"

# Permanent single-owner policy: our fork and the npm adapter implement the same
# tools. Even a manually reinstalled upstream copy must not coexist with the fork.
# Remove it only AFTER the declared fork has installed/updated successfully.
if grep -Eq '^git:github\.com/lukastk/pi-mcp-adapter(@|$)' "$1"; then
    installed="$(pi list --no-approve)"
    while IFS= read -r line; do
        case "$line" in
            '  npm:pi-mcp-adapter'|'  npm:pi-mcp-adapter@'*)
                echo "    replacing ${line#  } with the declared adapter fork"
                pi remove --no-approve "${line#  }"
                ;;
        esac
    done <<< "$installed"
fi

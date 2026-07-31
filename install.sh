#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
    cat <<EOF
Usage: ./install.sh [--prune] [--pi-only|--claude-only|--codex-only]

Runs the Pi, Claude Code, and Codex installers.

Options:
  --prune        Forwarded to all selected sub-scripts; removes stale entries.
  --pi-only      Only run scripts/install-pi.sh.
  --claude-only  Only run scripts/install-claude.sh.
  --codex-only   Only run scripts/install-codex.sh.
  -h, --help     Show this help.
EOF
}

PRUNE=false
RUN_PI=true
RUN_CLAUDE=true
RUN_CODEX=true

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prune)
            PRUNE=true
            ;;
        --pi-only)
            RUN_CLAUDE=false
            RUN_CODEX=false
            ;;
        --claude-only)
            RUN_PI=false
            RUN_CODEX=false
            ;;
        --codex-only)
            RUN_PI=false
            RUN_CLAUDE=false
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

sub_args=()
if [ "$PRUNE" = true ]; then
    sub_args+=("--prune")
fi

if [ "$RUN_PI" = true ]; then
    echo "########## Pi ##########"
    "$SCRIPT_DIR/scripts/install-pi.sh" "${sub_args[@]}"
    echo ""
fi

if [ "$RUN_CLAUDE" = true ]; then
    echo "########## Claude ##########"
    "$SCRIPT_DIR/scripts/install-claude.sh" "${sub_args[@]}"
    echo ""
fi

if [ "$RUN_CODEX" = true ]; then
    echo "########## Codex ##########"
    "$SCRIPT_DIR/scripts/install-codex.sh" "${sub_args[@]}"
fi

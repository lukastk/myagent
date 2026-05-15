#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
    cat <<EOF
Usage: ./install.sh [--prune] [--pi-only|--claude-only]

Runs scripts/install-pi.sh followed by scripts/install-claude.sh.

Options:
  --prune        Forwarded to both sub-scripts; removes stale entries.
  --pi-only      Only run scripts/install-pi.sh.
  --claude-only  Only run scripts/install-claude.sh.
  -h, --help     Show this help.
EOF
}

PRUNE=false
RUN_PI=true
RUN_CLAUDE=true

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prune)
            PRUNE=true
            ;;
        --pi-only)
            RUN_CLAUDE=false
            ;;
        --claude-only)
            RUN_PI=false
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
fi

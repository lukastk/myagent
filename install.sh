#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
EXTENSIONS_LIST="$SCRIPT_DIR/external_extensions.txt"
SKILLS_DIR="$HOME/.agents/skills"
SKILLS_LIST="$SCRIPT_DIR/external_skills.txt"

link_directory() {
    local source_dir="${1%/}"
    local destination_root="${2%/}"
    local name="$3"
    local target="$destination_root/$name"

    if [ -L "$target" ]; then
        local existing
        existing="$(readlink "$target")"
        existing="${existing%/}"
        if [ "$existing" = "$source_dir" ]; then
            echo "    $name (already linked)"
            return 0
        fi
        echo "    $name (updating symlink)"
        rm "$target"
    elif [ -e "$target" ]; then
        echo "    $name (SKIPPED — non-symlink already exists at $target)"
        return 1
    else
        echo "    $name"
    fi

    ln -s "$source_dir" "$target"
    return 0
}

shopt -s nullglob

echo "==> Installing local extensions"

mkdir -p "$EXTENSIONS_DIR"
local_extensions=("$SCRIPT_DIR"/extensions/*/)
if [ ${#local_extensions[@]} -eq 0 ]; then
    echo "    No local extensions found in $SCRIPT_DIR/extensions"
else
    for ext_dir in "${local_extensions[@]}"; do
        ext_name="$(basename "$ext_dir")"
        if ! link_directory "$ext_dir" "$EXTENSIONS_DIR" "$ext_name"; then
            continue
        fi

        if [ -f "$ext_dir/package.json" ]; then
            echo "      installing npm dependencies..."
            (cd "$ext_dir" && npm install --omit=dev)
        fi
    done
fi

echo ""
echo "==> Installing local skills"

mkdir -p "$SKILLS_DIR"
local_skills=("$SCRIPT_DIR"/skills/*/)
if [ ${#local_skills[@]} -eq 0 ]; then
    echo "    No local skills found in $SCRIPT_DIR/skills"
else
    for skill_dir in "${local_skills[@]}"; do
        skill_name="$(basename "$skill_dir")"
        if ! link_directory "$skill_dir" "$SKILLS_DIR" "$skill_name"; then
            continue
        fi

        if [ -f "$skill_dir/package.json" ]; then
            echo "      installing npm dependencies..."
            (cd "$skill_dir" && npm install --omit=dev)
        fi
    done
fi

echo ""
echo "==> Installing external extensions"

if [ ! -f "$EXTENSIONS_LIST" ]; then
    echo "    No external_extensions.txt found, skipping."
else
    while IFS= read -r line || [ -n "$line" ]; do
        line="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -z "$line" ] && continue

        echo "    $line"
        pi install "$line"
    done < "$EXTENSIONS_LIST"
fi

echo ""
echo "==> Installing external skills"

if [ ! -f "$SKILLS_LIST" ]; then
    echo "    No external_skills.txt found, skipping."
else
    if ! command -v npx >/dev/null 2>&1; then
        echo "    npx is required to install external skills."
        exit 1
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        line="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -z "$line" ] && continue

        echo "    $line"
        npx skills add "$line" -g -y
    done < "$SKILLS_LIST"
fi

echo ""
echo "==> Done. Reload Pi with /reload if it's running."

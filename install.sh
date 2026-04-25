#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
EXTENSIONS_LIST="$SCRIPT_DIR/external_extensions.txt"
SKILLS_DIR="$HOME/.agents/skills"
SKILLS_LIST="$SCRIPT_DIR/external_skills.txt"
STATE_DIR="$SCRIPT_DIR/.install-state"
EXT_STATE_FILE="$STATE_DIR/external_extensions.txt"
SKILL_STATE_FILE="$STATE_DIR/external_skills.txt"

PRUNE=false

usage() {
    cat <<EOF
Usage: ./install.sh [--prune]

Options:
  --prune      Remove stale local symlinks and uninstall previously managed
               external extensions/skills that are no longer listed.
  -h, --help   Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prune)
            PRUNE=true
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

TMP_FILES=()
new_tmp_file() {
    local __var_name="$1"
    local tmp
    tmp="$(mktemp)"
    printf -v "$__var_name" '%s' "$tmp"
    TMP_FILES+=("$tmp")
}
cleanup_tmp_files() {
    if [ "${#TMP_FILES[@]}" -gt 0 ]; then
        rm -f "${TMP_FILES[@]}"
    fi
}
trap cleanup_tmp_files EXIT

normalize_line() {
    local line="$1"
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    echo "$line"
}

normalize_list_file() {
    local source_file="$1"
    local output_file="$2"

    : > "$output_file"
    if [ ! -f "$source_file" ]; then
        return 0
    fi

    while IFS= read -r raw_line || [ -n "$raw_line" ]; do
        local line
        line="$(normalize_line "$raw_line")"
        [ -z "$line" ] && continue
        printf '%s\n' "$line" >> "$output_file"
    done < "$source_file"
}

file_contains_line() {
    local file_path="$1"
    local line="$2"

    [ -f "$file_path" ] || return 1
    grep -Fxq -- "$line" "$file_path"
}

ensure_state_line() {
    local state_file="$1"
    local line="$2"

    mkdir -p "$(dirname "$state_file")"
    touch "$state_file"
    if ! file_contains_line "$state_file" "$line"; then
        printf '%s\n' "$line" >> "$state_file"
    fi
}

remove_state_line() {
    local state_file="$1"
    local line="$2"

    [ -f "$state_file" ] || return 0

    local tmp
    new_tmp_file tmp
    grep -Fxv -- "$line" "$state_file" > "$tmp" || true
    mv "$tmp" "$state_file"
}

collect_local_names() {
    local source_root="${1%/}"
    local output_file="$2"

    : > "$output_file"
    local dirs=("$source_root"/*/)
    if [ "${#dirs[@]}" -eq 0 ]; then
        return 0
    fi

    for dir in "${dirs[@]}"; do
        printf '%s\n' "$(basename "$dir")" >> "$output_file"
    done
}

prune_local_symlinks() {
    local destination_root="${1%/}"
    local managed_source_root="${2%/}"
    local keep_names_file="$3"
    local label="$4"

    [ -d "$destination_root" ] || return 0

    local removed_any=false
    for target in "$destination_root"/*; do
        [ -L "$target" ] || continue

        local existing
        existing="$(readlink "$target")"
        existing="${existing%/}"

        case "$existing" in
            "$managed_source_root"/*)
                ;;
            *)
                continue
                ;;
        esac

        local name
        name="$(basename "$target")"
        if file_contains_line "$keep_names_file" "$name"; then
            continue
        fi

        if [ "$removed_any" = false ]; then
            echo "    Removing stale local $label symlinks"
            removed_any=true
        fi

        echo "      $name"
        rm "$target"
    done

    if [ "$removed_any" = false ]; then
        echo "    No stale local $label symlinks"
    fi
}

skill_name_from_source() {
    local source="$1"
    if [[ "$source" == *@* ]]; then
        echo "${source##*@}"
    else
        echo "$source"
    fi
}

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

new_tmp_file tmp_external_extensions
new_tmp_file tmp_external_skills
new_tmp_file tmp_local_extension_names
new_tmp_file tmp_local_skill_names

normalize_list_file "$EXTENSIONS_LIST" "$tmp_external_extensions"
normalize_list_file "$SKILLS_LIST" "$tmp_external_skills"
collect_local_names "$SCRIPT_DIR/extensions" "$tmp_local_extension_names"
collect_local_names "$SCRIPT_DIR/skills" "$tmp_local_skill_names"

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
        [ -z "$line" ] && continue
        echo "    $line"
        pi install "$line"
        ensure_state_line "$EXT_STATE_FILE" "$line"
    done < "$tmp_external_extensions"
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
        [ -z "$line" ] && continue

        echo "    $line"
        npx skills add "$line" -g -y
        ensure_state_line "$SKILL_STATE_FILE" "$line"
    done < "$tmp_external_skills"
fi

if [ "$PRUNE" = true ]; then
    echo ""
    echo "==> Pruning removed entries"

    prune_local_symlinks "$EXTENSIONS_DIR" "$SCRIPT_DIR/extensions" "$tmp_local_extension_names" "extension"
    prune_local_symlinks "$SKILLS_DIR" "$SCRIPT_DIR/skills" "$tmp_local_skill_names" "skill"

    echo ""
    echo "==> Pruning external extensions"
    if [ -f "$EXT_STATE_FILE" ]; then
        new_tmp_file installed_extension_sources
        pi list | sed -n 's/^  \([^[:space:]].*\)$/\1/p' > "$installed_extension_sources"

        removed_any=false
        while IFS= read -r source || [ -n "$source" ]; do
            [ -z "$source" ] && continue

            if file_contains_line "$tmp_external_extensions" "$source"; then
                continue
            fi

            removed_any=true
            if file_contains_line "$installed_extension_sources" "$source"; then
                echo "    removing $source"
                if pi remove "$source"; then
                    remove_state_line "$EXT_STATE_FILE" "$source"
                else
                    echo "      failed to remove $source; keeping it in state for retry"
                fi
            else
                echo "    $source (already absent)"
                remove_state_line "$EXT_STATE_FILE" "$source"
            fi
        done < "$EXT_STATE_FILE"

        if [ "$removed_any" = false ]; then
            echo "    No external extensions to prune"
        fi
    else
        echo "    No managed external extensions state found"
    fi

    echo ""
    echo "==> Pruning external skills"
    if [ -f "$SKILL_STATE_FILE" ]; then
        if ! command -v npx >/dev/null 2>&1; then
            echo "    npx is required to prune external skills."
            exit 1
        fi

        new_tmp_file installed_skill_names
        npx skills ls -g --json | sed -n 's/.*"name":[[:space:]]*"\([^"]*\)".*/\1/p' > "$installed_skill_names"

        removed_any=false
        while IFS= read -r source || [ -n "$source" ]; do
            [ -z "$source" ] && continue

            if file_contains_line "$tmp_external_skills" "$source"; then
                continue
            fi

            removed_any=true
            skill_name="$(skill_name_from_source "$source")"

            if file_contains_line "$installed_skill_names" "$skill_name"; then
                echo "    removing $skill_name (from $source)"
                if npx skills remove -g "$skill_name" -y; then
                    remove_state_line "$SKILL_STATE_FILE" "$source"
                else
                    echo "      failed to remove $skill_name; keeping it in state for retry"
                fi
            else
                echo "    $skill_name (from $source) already absent"
                remove_state_line "$SKILL_STATE_FILE" "$source"
            fi
        done < "$SKILL_STATE_FILE"

        if [ "$removed_any" = false ]; then
            echo "    No external skills to prune"
        fi
    else
        echo "    No managed external skills state found"
    fi
fi

echo ""
echo "==> Done. Reload Pi with /reload if it's running."
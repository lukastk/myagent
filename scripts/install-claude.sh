#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
SHARED_SKILLS_DIR="$HOME/.agents/skills"
SKILLS_LIST="$REPO_ROOT/external_skills.txt"
MCP_CONFIG="$REPO_ROOT/mcp.json"
STATE_DIR="$REPO_ROOT/.install-state"
CLAUDE_SKILL_STATE_FILE="$STATE_DIR/claude_skills.txt"
CLAUDE_MCP_STATE_FILE="$STATE_DIR/claude_mcp.txt"

PRUNE=false

usage() {
    cat <<EOF
Usage: scripts/install-claude.sh [--prune]

Installs myagent's skills and MCP servers into Claude Code's locations:
  - Skills (local + external) symlinked into ~/.claude/skills/
  - MCP servers from mcp.json applied via 'claude mcp add-json' at user scope

Options:
  --prune      Remove stale skill symlinks and previously managed MCP servers
               that are no longer listed.
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

if ! command -v claude >/dev/null 2>&1; then
    echo "Error: 'claude' CLI not found in PATH. Install Claude Code first." >&2
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: 'python3' is required to parse mcp.json." >&2
    exit 1
fi

mkdir -p "$STATE_DIR"

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

# Derive skill folder name from an external_skills.txt source line.
# Format: <owner>/<repo>@<skill-name>  →  <skill-name>
#         (fallback: the source line as-is)
skill_name_from_source() {
    local source="$1"
    if [[ "$source" == *@* ]]; then
        echo "${source##*@}"
    else
        echo "$source"
    fi
}

link_skill() {
    local source_dir="${1%/}"
    local name="$2"
    local target="$CLAUDE_SKILLS_DIR/$name"

    if [ ! -e "$source_dir" ]; then
        echo "    $name (SKIPPED — source missing: $source_dir)"
        return 1
    fi

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

mkdir -p "$CLAUDE_SKILLS_DIR"

echo "==> Linking local skills into Claude"

new_tmp_file tmp_managed_skill_names
: > "$tmp_managed_skill_names"

local_skills=("$REPO_ROOT"/skills/*/)
if [ ${#local_skills[@]} -eq 0 ]; then
    echo "    No local skills found in $REPO_ROOT/skills"
else
    for skill_dir in "${local_skills[@]}"; do
        skill_name="$(basename "$skill_dir")"
        if link_skill "$skill_dir" "$skill_name"; then
            ensure_state_line "$CLAUDE_SKILL_STATE_FILE" "$skill_name"
            printf '%s\n' "$skill_name" >> "$tmp_managed_skill_names"
        fi
    done
fi

echo ""
echo "==> Linking external skills into Claude"

if [ ! -f "$SKILLS_LIST" ]; then
    echo "    No external_skills.txt found, skipping."
else
    while IFS= read -r raw_line || [ -n "$raw_line" ]; do
        line="$(normalize_line "$raw_line")"
        [ -z "$line" ] && continue

        skill_name="$(skill_name_from_source "$line")"
        skill_dir="$SHARED_SKILLS_DIR/$skill_name"

        if link_skill "$skill_dir" "$skill_name"; then
            ensure_state_line "$CLAUDE_SKILL_STATE_FILE" "$skill_name"
            printf '%s\n' "$skill_name" >> "$tmp_managed_skill_names"
        fi
    done < "$SKILLS_LIST"
fi

echo ""
echo "==> Applying MCP servers to Claude (user scope)"

if [ ! -f "$MCP_CONFIG" ]; then
    echo "    No mcp.json found, skipping."
else
    # Emit one TSV row per server:  <name>\t<json-payload-for-add-json>
    # If `cwd` is set, we wrap as `sh -c "cd <cwd> && exec <command> <args...>"`
    # because `claude mcp add-json` silently drops the `cwd` field.
    # `lifecycle` is Pi-specific and always stripped.
    new_tmp_file tmp_mcp_rows
    python3 - "$MCP_CONFIG" > "$tmp_mcp_rows" <<'PY'
import json, os, shlex, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

for name, cfg in (data.get("mcpServers") or {}).items():
    out = {"type": "stdio"}
    command = cfg.get("command")
    args = list(cfg.get("args") or [])
    cwd = cfg.get("cwd")
    env = cfg.get("env") or {}

    if cwd:
        cwd = os.path.expandvars(os.path.expanduser(cwd))
        wrapped = f"cd {shlex.quote(cwd)} && exec {shlex.quote(command)}"
        for a in args:
            wrapped += " " + shlex.quote(a)
        out["command"] = "sh"
        out["args"] = ["-c", wrapped]
    else:
        out["command"] = command
        out["args"] = args

    if env:
        out["env"] = env

    print(f"{name}\t{json.dumps(out)}")
PY

    new_tmp_file tmp_managed_mcp_names
    : > "$tmp_managed_mcp_names"

    while IFS=$'\t' read -r name payload || [ -n "$name" ]; do
        [ -z "$name" ] && continue
        echo "    $name"
        # Remove any prior user-scope entry so re-runs are idempotent.
        claude mcp remove "$name" -s user >/dev/null 2>&1 || true
        if claude mcp add-json "$name" "$payload" -s user >/dev/null; then
            ensure_state_line "$CLAUDE_MCP_STATE_FILE" "$name"
            printf '%s\n' "$name" >> "$tmp_managed_mcp_names"
        else
            echo "      failed to add $name" >&2
        fi
    done < "$tmp_mcp_rows"
fi

if [ "$PRUNE" = true ]; then
    echo ""
    echo "==> Pruning stale Claude skill links"

    if [ -f "$CLAUDE_SKILL_STATE_FILE" ]; then
        removed_any=false
        while IFS= read -r name <&3 || [ -n "$name" ]; do
            [ -z "$name" ] && continue
            if file_contains_line "$tmp_managed_skill_names" "$name"; then
                continue
            fi
            target="$CLAUDE_SKILLS_DIR/$name"
            if [ -L "$target" ]; then
                existing="$(readlink "$target")"
                existing="${existing%/}"
                case "$existing" in
                    "$REPO_ROOT"/skills/*|"$SHARED_SKILLS_DIR"/*)
                        echo "    removing $name"
                        rm "$target"
                        ;;
                    *)
                        echo "    $name (symlink target is not myagent-managed, leaving in place)"
                        ;;
                esac
            else
                echo "    $name (already absent)"
            fi
            remove_state_line "$CLAUDE_SKILL_STATE_FILE" "$name"
            removed_any=true
        done 3< "$CLAUDE_SKILL_STATE_FILE"

        if [ "$removed_any" = false ]; then
            echo "    No stale Claude skill links"
        fi
    else
        echo "    No managed Claude skill state found"
    fi

    echo ""
    echo "==> Pruning stale Claude MCP servers"

    if [ -f "$CLAUDE_MCP_STATE_FILE" ]; then
        removed_any=false
        while IFS= read -r name <&3 || [ -n "$name" ]; do
            [ -z "$name" ] && continue
            if file_contains_line "$tmp_managed_mcp_names" "$name"; then
                continue
            fi
            echo "    removing $name"
            claude mcp remove "$name" -s user >/dev/null 2>&1 || true
            remove_state_line "$CLAUDE_MCP_STATE_FILE" "$name"
            removed_any=true
        done 3< "$CLAUDE_MCP_STATE_FILE"

        if [ "$removed_any" = false ]; then
            echo "    No stale Claude MCP servers"
        fi
    else
        echo "    No managed Claude MCP state found"
    fi
fi

echo ""
echo "==> Done. Restart Claude Code to pick up new skills/MCP servers."

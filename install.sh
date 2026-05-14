#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
EXTENSIONS_LIST="$SCRIPT_DIR/external_extensions.txt"
EXTENSIONS_MAC_LIST="$SCRIPT_DIR/external_extensions_mac.txt"
SKILLS_DIR="$HOME/.agents/skills"
SKILLS_LIST="$SCRIPT_DIR/external_skills.txt"
MCP_CONFIG="$SCRIPT_DIR/mcp.json"
MCP_DEST_DIR="$HOME/.config/mcp"
MCP_DEST="$MCP_DEST_DIR/mcp.json"
MCP_PI_DEST_DIR="$HOME/.pi/agent"
MCP_PI_DEST="$MCP_PI_DEST_DIR/mcp.json"
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

FD_VERSION="10.3.0"

find_working_fd_binary() {
    local pi_fd_path="$1"
    local candidate=""

    if command -v fdfind >/dev/null 2>&1; then
        candidate="$(command -v fdfind)"
        if [ "$candidate" != "$pi_fd_path" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    fi

    local fd_candidates=()
    mapfile -t fd_candidates < <(which -a fd 2>/dev/null | awk '!seen[$0]++')
    for candidate in "${fd_candidates[@]}"; do
        [ -n "$candidate" ] || continue
        [ "$candidate" = "$pi_fd_path" ] && continue
        [ -x "$candidate" ] || continue
        if "$candidate" --version >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done

    return 1
}

download_fd_binary() {
    local target_path="$1"
    local os arch target asset url tmp_dir archive extracted

    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Darwin)
            case "$arch" in
                arm64|aarch64) target="aarch64-apple-darwin" ;;
                x86_64) target="x86_64-apple-darwin" ;;
                *)
                    echo "    Unsupported macOS architecture for fd: $arch"
                    return 1
                    ;;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64) target="x86_64-unknown-linux-gnu" ;;
                arm64|aarch64) target="aarch64-unknown-linux-gnu" ;;
                *)
                    echo "    Unsupported Linux architecture for fd: $arch"
                    return 1
                    ;;
            esac
            ;;
        *)
            echo "    Unsupported OS for fd bootstrap: $os"
            return 1
            ;;
    esac

    asset="fd-v${FD_VERSION}-${target}.tar.gz"
    url="https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${asset}"

    tmp_dir="$(mktemp -d)"
    archive="$tmp_dir/$asset"
    curl -fsSL "$url" -o "$archive"
    tar -xzf "$archive" -C "$tmp_dir"

    extracted="$tmp_dir/fd-v${FD_VERSION}-${target}/fd"
    if [ ! -f "$extracted" ]; then
        extracted="$(find "$tmp_dir" -type f -name fd | head -n 1)"
    fi
    if [ -z "${extracted:-}" ] || [ ! -f "$extracted" ]; then
        rm -rf "$tmp_dir"
        echo "    Failed to locate fd binary after extracting $asset"
        return 1
    fi

    cp "$extracted" "$target_path"
    chmod 755 "$target_path"
    rm -rf "$tmp_dir"

    return 0
}

configure_pi_fd_binary() {
    local pi_bin_dir="$HOME/.pi/agent/bin"
    local pi_fd_path="$pi_bin_dir/fd"
    local candidate=""

    mkdir -p "$pi_bin_dir"

    if candidate="$(find_working_fd_binary "$pi_fd_path")"; then
        if [ -L "$pi_fd_path" ] && [ "$(readlink "$pi_fd_path")" = "$candidate" ]; then
            echo "    fd -> $candidate (already linked)"
            return 0
        fi

        rm -f "$pi_fd_path"
        ln -s "$candidate" "$pi_fd_path"
        echo "    fd -> $candidate"
        return 0
    fi

    if [ -x "$pi_fd_path" ] && "$pi_fd_path" --version >/dev/null 2>&1; then
        echo "    fd (existing Pi-managed binary is usable)"
        return 0
    fi

    if [ -e "$pi_fd_path" ] || [ -L "$pi_fd_path" ]; then
        echo "    Removing unusable $pi_fd_path"
        rm -f "$pi_fd_path"
    fi

    echo "    Bootstrapping fd v$FD_VERSION for this platform"
    if download_fd_binary "$pi_fd_path"; then
        echo "    fd installed at $pi_fd_path"
        return 0
    fi

    echo "    Failed to bootstrap fd; install fd/fdfind manually"
    return 1
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
new_tmp_file tmp_mac_extensions
new_tmp_file tmp_effective_external_extensions
new_tmp_file tmp_external_skills
new_tmp_file tmp_local_extension_names
new_tmp_file tmp_local_skill_names

normalize_list_file "$EXTENSIONS_LIST" "$tmp_external_extensions"
: > "$tmp_mac_extensions"
if [ "$(uname -s)" = "Darwin" ] && [ -f "$EXTENSIONS_MAC_LIST" ]; then
    normalize_list_file "$EXTENSIONS_MAC_LIST" "$tmp_mac_extensions"
fi
cat "$tmp_external_extensions" "$tmp_mac_extensions" > "$tmp_effective_external_extensions"
sort -u "$tmp_effective_external_extensions" -o "$tmp_effective_external_extensions"
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
echo "==> Installing MCP config"

if [ -f "$MCP_CONFIG" ]; then
    mkdir -p "$MCP_DEST_DIR"
    if [ -L "$MCP_DEST" ]; then
        existing="$(readlink "$MCP_DEST")"
        if [ "$existing" = "$MCP_CONFIG" ]; then
            echo "    mcp.json (already linked)"
        else
            echo "    mcp.json (updating symlink)"
            rm "$MCP_DEST"
            ln -s "$MCP_CONFIG" "$MCP_DEST"
        fi
    elif [ -e "$MCP_DEST" ]; then
        echo "    SKIPPED — $MCP_DEST already exists and is not a symlink."
        echo "    Merge manually or remove it to allow symlinking."
    else
        echo "    mcp.json -> $MCP_DEST"
        ln -s "$MCP_CONFIG" "$MCP_DEST"
    fi

    # Also symlink to Pi-specific location
    mkdir -p "$MCP_PI_DEST_DIR"
    if [ -L "$MCP_PI_DEST" ]; then
        existing="$(readlink "$MCP_PI_DEST")"
        if [ "$existing" != "$MCP_CONFIG" ]; then
            rm "$MCP_PI_DEST"
            ln -s "$MCP_CONFIG" "$MCP_PI_DEST"
        fi
    elif [ ! -e "$MCP_PI_DEST" ]; then
        echo "    mcp.json -> $MCP_PI_DEST"
        ln -s "$MCP_CONFIG" "$MCP_PI_DEST"
    fi
else
    echo "    No mcp.json found, skipping."
fi

echo ""
echo "==> Configuring Pi tool binaries"
configure_pi_fd_binary

echo ""
echo "==> Installing Playwright MCP (patched)"

# Playwright MCP is installed persistently (not via npx) so we can patch it.
# mcp.json references this install at ~/.local/playwright-mcp.
#
# PATCH: Skip Browser.setDownloadBehavior in CDP connections.
# Brave (and some other Chromium browsers) rejects this CDP call when connected
# via --remote-debugging-port, causing "Browser context management is not
# supported" errors. Playwright unconditionally sends this call during context
# initialization in crBrowser.js.
#
# Upstream fix: Playwright PR #40185 added a `noDefaults` option to
# connectOverCDP() (merged 2026-04-21). Once @playwright/mcp ships a version
# that uses noDefaults for CDP connections, this patch and the persistent
# install can be removed — switch mcp.json back to npx.
#
# Track: https://github.com/nicobailon/pi-mcp-adapter/issues (or Playwright MCP)

PLAYWRIGHT_MCP_DIR="$HOME/.local/playwright-mcp"
PLAYWRIGHT_PATCH_TARGET="$PLAYWRIGHT_MCP_DIR/node_modules/playwright-core/lib/server/chromium/crBrowser.js"
PLAYWRIGHT_PATCH_MARKER="patched for Brave CDP"

mkdir -p "$PLAYWRIGHT_MCP_DIR"

# Install if not present or if package.json is missing
if [ ! -f "$PLAYWRIGHT_MCP_DIR/node_modules/@playwright/mcp/cli.js" ]; then
    echo "    Installing @playwright/mcp..."
    (cd "$PLAYWRIGHT_MCP_DIR" && npm init -y --silent 2>/dev/null && npm install @playwright/mcp@latest 2>&1 | tail -3)
else
    echo "    @playwright/mcp already installed"
fi

# Apply patch if not already applied
if [ -f "$PLAYWRIGHT_PATCH_TARGET" ]; then
    if grep -q "$PLAYWRIGHT_PATCH_MARKER" "$PLAYWRIGHT_PATCH_TARGET"; then
        echo "    crBrowser.js patch (already applied)"
    else
        echo "    Patching crBrowser.js (skip setDownloadBehavior for Brave CDP)..."
        cp "$PLAYWRIGHT_PATCH_TARGET" "$PLAYWRIGHT_PATCH_TARGET.bak"
        sed -i '' "s/this._options.acceptDownloads !== \"internal-browser-default\"/false \/* $PLAYWRIGHT_PATCH_MARKER *\//" "$PLAYWRIGHT_PATCH_TARGET"
        if grep -q "$PLAYWRIGHT_PATCH_MARKER" "$PLAYWRIGHT_PATCH_TARGET"; then
            echo "    Patch applied successfully"
        else
            echo "    WARNING: Patch failed — restoring backup"
            mv "$PLAYWRIGHT_PATCH_TARGET.bak" "$PLAYWRIGHT_PATCH_TARGET"
        fi
    fi
else
    echo "    WARNING: crBrowser.js not found at expected path"
fi

echo ""
echo "==> Installing external extensions"

if [ ! -f "$EXTENSIONS_LIST" ]; then
    echo "    No external_extensions.txt found, skipping."
else
    while IFS= read -r line <&3 || [ -n "$line" ]; do
        [ -z "$line" ] && continue
        echo "    $line"
        pi install "$line"
        ensure_state_line "$EXT_STATE_FILE" "$line"
    done 3< "$tmp_external_extensions"
fi

echo ""
echo "==> Installing platform-specific extensions"

if [ "$(uname -s)" = "Darwin" ]; then
    if [ -s "$tmp_mac_extensions" ]; then
        while IFS= read -r line <&3 || [ -n "$line" ]; do
            [ -z "$line" ] && continue
            echo "    $line (macOS)"
            pi install "$line"
            ensure_state_line "$EXT_STATE_FILE" "$line"
        done 3< "$tmp_mac_extensions"
    else
        echo "    No macOS extension entries found, skipping."
    fi
else
    echo "    Skipping macOS extensions (not on Darwin)"
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

    while IFS= read -r line <&3 || [ -n "$line" ]; do
        [ -z "$line" ] && continue

        echo "    $line"
        npx skills add "$line" -g -y
        ensure_state_line "$SKILL_STATE_FILE" "$line"
    done 3< "$tmp_external_skills"
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
        while IFS= read -r source <&3 || [ -n "$source" ]; do
            [ -z "$source" ] && continue

            if file_contains_line "$tmp_effective_external_extensions" "$source"; then
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
        done 3< "$EXT_STATE_FILE"

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
        while IFS= read -r source <&3 || [ -n "$source" ]; do
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
        done 3< "$SKILL_STATE_FILE"

        if [ "$removed_any" = false ]; then
            echo "    No external skills to prune"
        fi
    else
        echo "    No managed external skills state found"
    fi
fi

echo ""
echo "==> Done. Reload Pi with /reload if it's running."
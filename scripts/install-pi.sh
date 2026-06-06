#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
EXTENSIONS_LIST="$REPO_ROOT/external_extensions.txt"
EXTENSIONS_MAC_LIST="$REPO_ROOT/external_extensions_mac.txt"
SKILLS_DIR="$HOME/.agents/skills"
SKILLS_LIST="$REPO_ROOT/external_skills.txt"
PI_SETTINGS_SRC="$REPO_ROOT/pi_settings.json"
PI_SETTINGS_DEST="$HOME/.pi/agent/settings.json"
MCP_CONFIG="$REPO_ROOT/mcp.json"
MCP_DEST_DIR="$HOME/.config/mcp"
MCP_DEST="$MCP_DEST_DIR/mcp.json"
MCP_PI_DEST_DIR="$HOME/.pi/agent"
MCP_PI_DEST="$MCP_PI_DEST_DIR/mcp.json"
STATE_DIR="$REPO_ROOT/.install-state"
# External extensions are pruned by reconciling `pi list` (reality) against the
# declared lists — no state file. A state file of "what we installed" structurally
# can't see orphans installed by other tooling, which is how pi-slopchop survived a
# prior prune. Skills still use a state file (see SKILL_STATE_FILE).
LEGACY_EXT_STATE_FILE="$STATE_DIR/external_extensions.txt"
SKILL_STATE_FILE="$STATE_DIR/external_skills.txt"
PI_TOOL_BINARIES_SCRIPT="$SCRIPT_DIR/configure-pi-tool-binaries.sh"

PRUNE=false

usage() {
    cat <<EOF
Usage: scripts/install-pi.sh [--prune]

Installs Pi extensions, local skills (into ~/.agents/skills/), external skills,
and symlinks mcp.json into Pi's expected locations.

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

    # Use a name distinct from `tmp` because new_tmp_file's own `local tmp`
    # shadows a caller-declared `tmp` and leaves it unbound under set -u.
    local tmp_path
    new_tmp_file tmp_path
    grep -Fxv -- "$line" "$state_file" > "$tmp_path" || true
    mv "$tmp_path" "$state_file"
}

# Pi tool binary configuration lives in scripts/configure-pi-tool-binaries.sh

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
collect_local_names "$REPO_ROOT/extensions" "$tmp_local_extension_names"
collect_local_names "$REPO_ROOT/skills" "$tmp_local_skill_names"

echo "==> Installing local extensions"

mkdir -p "$EXTENSIONS_DIR"
local_extensions=("$REPO_ROOT"/extensions/*/)
if [ ${#local_extensions[@]} -eq 0 ]; then
    echo "    No local extensions found in $REPO_ROOT/extensions"
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
local_skills=("$REPO_ROOT"/skills/*/)
if [ ${#local_skills[@]} -eq 0 ]; then
    echo "    No local skills found in $REPO_ROOT/skills"
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
echo "==> Merging Pi settings"

# pi_settings.json holds our declarative Pi settings (default model/provider,
# enabled models, model-scope list). It is SHALLOW-MERGED on top of the live
# ~/.pi/agent/settings.json: our keys overwrite, but any keys we don't declare
# are preserved. This matters because Pi mutates settings.json at runtime —
# `packages` (the installed-extension list, owned here by external_extensions.txt
# via `pi install`), `lastChangelogVersion`, etc. A symlink or wholesale copy
# would clobber that runtime state, so we deliberately overlay instead.
#
# We intentionally do NOT declare `packages` in pi_settings.json:
# external_extensions.txt is the single source of truth (installed by the
# `pi install` loop below). Declaring it here too would recreate a split-brain.
#
# `shellPath` IS injected, but computed here rather than stored statically,
# because the correct path is machine-specific (/bin/zsh on mac, a termux path,
# etc.). Pi does NOT auto-detect zsh: with no shellPath its getShellConfig()
# goes straight to /bin/bash (see dist/utils/shell.js) — which is the original
# bug this setting fixes. So we resolve the real zsh via `command -v zsh` and
# set it, but only when zsh exists and the live settings don't already pin a
# shellPath (never override a deliberate user choice; never set a bad path).
if [ -f "$PI_SETTINGS_SRC" ]; then
    if ! command -v jq >/dev/null 2>&1; then
        echo "    jq is required to merge Pi settings."
        exit 1
    fi
    mkdir -p "$(dirname "$PI_SETTINGS_DEST")"

    new_tmp_file tmp_overlay
    cp "$PI_SETTINGS_SRC" "$tmp_overlay"

    # Inject shellPath = zsh (resolved on this machine) unless the live settings
    # already pin one. Skip silently if zsh isn't installed.
    existing_shell=""
    if [ -f "$PI_SETTINGS_DEST" ]; then
        existing_shell="$(jq -r '.shellPath // empty' "$PI_SETTINGS_DEST" 2>/dev/null || true)"
    fi
    if [ -n "$existing_shell" ]; then
        echo "    shellPath (keeping existing: $existing_shell)"
    elif zsh_path="$(command -v zsh)" && [ -n "$zsh_path" ]; then
        new_tmp_file tmp_overlay2
        jq --arg sh "$zsh_path" '. + {shellPath: $sh}' "$tmp_overlay" > "$tmp_overlay2"
        mv "$tmp_overlay2" "$tmp_overlay"
        echo "    shellPath -> $zsh_path"
    else
        echo "    shellPath (zsh not found — leaving Pi to fall back to /bin/bash)"
    fi

    new_tmp_file tmp_merged_settings
    if [ -f "$PI_SETTINGS_DEST" ]; then
        # existing * ours → ours wins on conflicts, existing keys preserved
        jq -s '.[0] * .[1]' "$PI_SETTINGS_DEST" "$tmp_overlay" > "$tmp_merged_settings"
        echo "    settings.json (merged onto existing)"
    else
        cp "$tmp_overlay" "$tmp_merged_settings"
        echo "    settings.json (created)"
    fi
    mv "$tmp_merged_settings" "$PI_SETTINGS_DEST"
else
    echo "    No pi_settings.json found, skipping."
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

    # Also symlink to Pi-specific location. This is the config pi-mcp-adapter
    # actually reads, so a stale REGULAR file here silently shadows the repo
    # config (it bit us once — an old hand-written mcp.json kept Pi on a
    # non-wrapped playwright server). Unlike ~/.config/mcp (left untouched if a
    # user put a real file there), adopt this path: back up a non-symlink and
    # replace it with the symlink so the repo config always wins for Pi.
    mkdir -p "$MCP_PI_DEST_DIR"
    if [ -L "$MCP_PI_DEST" ]; then
        existing="$(readlink "$MCP_PI_DEST")"
        if [ "$existing" != "$MCP_CONFIG" ]; then
            rm "$MCP_PI_DEST"
            ln -s "$MCP_CONFIG" "$MCP_PI_DEST"
        fi
    else
        if [ -e "$MCP_PI_DEST" ]; then
            backup="$MCP_PI_DEST.stale-$(date +%s).bak"
            echo "    $MCP_PI_DEST is a non-symlink — backing up to $backup and adopting"
            mv "$MCP_PI_DEST" "$backup"
        fi
        echo "    mcp.json -> $MCP_PI_DEST"
        ln -s "$MCP_CONFIG" "$MCP_PI_DEST"
    fi
else
    echo "    No mcp.json found, skipping."
fi

echo ""
echo "==> Configuring Pi tool binaries"
if [ -f "$PI_TOOL_BINARIES_SCRIPT" ]; then
    bash "$PI_TOOL_BINARIES_SCRIPT"
else
    echo "    Missing script: $PI_TOOL_BINARIES_SCRIPT" >&2
    exit 1
fi

echo ""
echo "==> Installing Playwright MCP (patched)"

# Playwright MCP is installed persistently (not via npx) so we can patch
# playwright-core for Brave. mcp.json references this install at
# ~/.local/playwright-mcp.
#
# LAYOUT NOTE: playwright-core >= 1.61 BUNDLES its server modules into a single
# lib/coreBundle.js; older versions shipped separate files under
# lib/server/chromium/ (crBrowser.js, chromiumSwitches.js). We therefore LOCATE
# each patch target by searching for its code string rather than hardcoding a
# path. A hardcoded path silently stopped matching after a playwright bump,
# leaving Brave unpatched on every machine while the installer only warned — so
# a patch that is expected but cannot be applied now FAILS LOUDLY (exit 1).
#
# Upstream fix: Playwright PR #40185 added a `noDefaults` option to
# connectOverCDP() (merged 2026-04-21). Once @playwright/mcp passes it for CDP
# connections, the setDownloadBehavior patch and the persistent install can be
# dropped — switch mcp.json back to npx.

PLAYWRIGHT_MCP_DIR="$HOME/.local/playwright-mcp"
PLAYWRIGHT_CORE_DIR="$PLAYWRIGHT_MCP_DIR/node_modules/playwright-core"

mkdir -p "$PLAYWRIGHT_MCP_DIR"

# Install if not present or if package.json is missing
if [ ! -f "$PLAYWRIGHT_MCP_DIR/node_modules/@playwright/mcp/cli.js" ]; then
    echo "    Installing @playwright/mcp..."
    (cd "$PLAYWRIGHT_MCP_DIR" && npm init -y --silent 2>/dev/null && npm install @playwright/mcp@latest 2>&1 | tail -3)
else
    echo "    @playwright/mcp already installed"
fi

# Portable in-place edit. GNU and BSD `sed -i` take incompatible arguments
# (`-i` vs `-i ''`); editing via a temp file sidesteps that entirely so the same
# code runs on Linux and macOS.
sed_inplace() {
    local expr="$1" file="$2" tmp
    tmp="$(mktemp)"
    sed "$expr" "$file" > "$tmp"
    mv "$tmp" "$file"
}

# Find the playwright-core file that contains a fixed string (ignoring our own
# .bak backups). Empty output if none.
find_core_file_with() {
    grep -rlF "$1" "$PLAYWRIGHT_CORE_DIR" 2>/dev/null | grep -v '\.bak$' | head -1
}

# Apply a one-shot string replacement to whichever core file holds it.
#   $1 label   $2 target string   $3 replacement (must contain the marker)
#   $4 done-marker
# Idempotent (skips when the marker is already present); LOUD on failure.
apply_core_patch() {
    local label="$1" target="$2" repl="$3" marker="$4"

    if [ -n "$(find_core_file_with "$marker")" ]; then
        echo "    $label (already applied)"
        return 0
    fi

    local file
    file="$(find_core_file_with "$target")"
    if [ -z "$file" ]; then
        echo "    ERROR: $label — neither the target code nor the marker was found" >&2
        echo "           in $PLAYWRIGHT_CORE_DIR. playwright-core layout likely" >&2
        echo "           changed again; update this patch." >&2
        exit 1
    fi

    echo "    $label (patching $(basename "$file"))"
    cp "$file" "$file.bak"
    # `|` delimiter so the `/` in the comment marker needs no escaping.
    sed_inplace "s|$target|$repl|" "$file"
    if grep -qF "$marker" "$file"; then
        echo "      ok"
        rm -f "$file.bak"
    else
        echo "    ERROR: $label — replacement did not take; restored backup" >&2
        mv "$file.bak" "$file"
        exit 1
    fi
}

# PATCH 1 (all platforms): skip the Chromium `Browser.setDownloadBehavior` CDP
# call. Brave rejects it when driven over CDP (the connect path Linux always
# uses, and the macOS BRAVE_CDP_REAL opt-out), raising "Browser context
# management is not supported". We neutralise only the Chromium guard — the
# compound condition that also checks `name !== "clank"` — leaving the unrelated
# BiDi/Firefox download path intact. Harmless in launch mode (just doesn't
# configure download behaviour), so it is applied everywhere.
apply_core_patch \
    "setDownloadBehavior skip" \
    'this._browser.options.name !== "clank" && this._options.acceptDownloads !== "internal-browser-default"' \
    'false /* patched for Brave CDP */' \
    'patched for Brave CDP'

# PATCH 2 (macOS only): drop --use-mock-keychain / --password-store=basic from
# the Chromium launch switches. In isolated launch mode (the macOS default)
# Playwright LAUNCHES Brave itself; those switches force a mock keychain so the
# launched Brave can't decrypt the seeded profile's cookies and lands logged-out.
# Removing them lets Brave use the real macOS "Brave Safe Storage" key (already
# granted to the Brave app) → the isolated browser is logged in. On Linux the
# launcher CONNECTS to an existing Brave and never launches one, so these
# switches are irrelevant — skip the patch entirely there.
if [ "$(uname -s)" = "Darwin" ]; then
    # The switch lives in coreBundle.js (bundled) or the legacy per-file
    # chromiumSwitches.js. Deliberately NOT electron/loader.js — that copy is the
    # Electron launch path, not how we launch Brave.
    switches_file=""
    for cand in \
        "$PLAYWRIGHT_CORE_DIR/lib/coreBundle.js" \
        "$PLAYWRIGHT_CORE_DIR/lib/server/chromium/chromiumSwitches.js"; do
        [ -f "$cand" ] && { switches_file="$cand"; break; }
    done
    if [ -z "$switches_file" ]; then
        echo "    ERROR: mock-keychain patch — no chromium switches file found in" >&2
        echo "           $PLAYWRIGHT_CORE_DIR (coreBundle.js / chromiumSwitches.js)." >&2
        exit 1
    fi
    if grep -qF '"--use-mock-keychain"' "$switches_file"; then
        echo "    mock-keychain patch (patching $(basename "$switches_file"))"
        cp "$switches_file" "$switches_file.bak"
        sed_inplace 's|"--password-store=basic",||; s|"--use-mock-keychain",||' "$switches_file"
        if grep -qF '"--use-mock-keychain"' "$switches_file"; then
            echo "    ERROR: mock-keychain patch did not take; restored backup" >&2
            mv "$switches_file.bak" "$switches_file"
            exit 1
        fi
        echo "      ok"
        rm -f "$switches_file.bak"
    else
        echo "    mock-keychain patch (already applied)"
    fi
else
    echo "    mock-keychain patch (skipped — not macOS; launcher connects, never launches)"
fi

# PATCH 3 (all platforms): clarify the browser_close tool description. Upstream
# ships it as "Close the page", which made agents think it only closes the
# current tab and leave the (expensive) per-agent Brave running for the whole
# session. browser_close actually disposes the backend, which closes the context
# AND the browser process (see playwright-core mcp/program.js `disposed`), fully
# freeing its memory; Playwright relaunches the browser on the next browser tool
# call. The new wording tells agents to close it when done. (Scope note: closing
# is right for the default ISOLATED browser, not the BRAVE_CDP_REAL main browser
# where it would shut the user's real window — that caveat lives in the global
# browser-usage note, since the tool description is shared by both servers.)
apply_core_patch \
    "browser_close description" \
    'description: "Close the page"' \
    'description: "Close the entire browser, ending its process and freeing all of its memory. This does NOT merely close the current tab. Playwright relaunches the browser automatically on the next browser tool call, so call this as soon as you finish browsing to release resources." /* patched: browser_close frees resources */' \
    'patched: browser_close frees resources'

# Symlink the per-agent isolated-Brave launcher next to the playwright install,
# so mcp.json's playwright server (command: bash, args: [brave-cdp-mcp],
# cwd: ~/.local/playwright-mcp) can find it. The wrapper gives each agent its
# own logged-in Brave; see scripts/brave-cdp/brave-cdp-mcp.
BRAVE_CDP_WRAPPER_SRC="$REPO_ROOT/scripts/brave-cdp/brave-cdp-mcp"
BRAVE_CDP_WRAPPER_DEST="$PLAYWRIGHT_MCP_DIR/brave-cdp-mcp"
if [ -f "$BRAVE_CDP_WRAPPER_SRC" ]; then
    chmod +x "$BRAVE_CDP_WRAPPER_SRC"
    ln -sfn "$BRAVE_CDP_WRAPPER_SRC" "$BRAVE_CDP_WRAPPER_DEST"
    echo "    Linked brave-cdp-mcp launcher"
else
    echo "    WARNING: brave-cdp-mcp wrapper not found at $BRAVE_CDP_WRAPPER_SRC"
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
        npx -y skills add "$line" -g -y
        ensure_state_line "$SKILL_STATE_FILE" "$line"
    done 3< "$tmp_external_skills"
fi

if [ "$PRUNE" = true ]; then
    echo ""
    echo "==> Pruning removed entries"

    prune_local_symlinks "$EXTENSIONS_DIR" "$REPO_ROOT/extensions" "$tmp_local_extension_names" "extension"
    prune_local_symlinks "$SKILLS_DIR" "$REPO_ROOT/skills" "$tmp_local_skill_names" "skill"

    echo ""
    echo "==> Pruning external extensions (reconcile to external_extensions.txt)"
    # Reconcile installed-vs-declared: iterate the extensions Pi actually has
    # (`pi list`) and remove any not in the declared desired set
    # ($tmp_effective_external_extensions = external_extensions.txt, plus the mac
    # list only on macOS). This removes ANY undeclared extension, including
    # orphans myagent never installed itself — a state file of our own past
    # installs couldn't see those (that's how pi-slopchop survived a prior prune).
    new_tmp_file installed_extension_sources
    pi list | sed -n 's/^  \([^[:space:]].*\)$/\1/p' > "$installed_extension_sources"

    removed_any=false
    while IFS= read -r source <&3 || [ -n "$source" ]; do
        [ -z "$source" ] && continue

        if file_contains_line "$tmp_effective_external_extensions" "$source"; then
            continue
        fi

        removed_any=true
        echo "    removing $source (not declared in myagent)"
        if ! pi remove "$source"; then
            echo "      failed to remove $source"
        fi
    done 3< "$installed_extension_sources"

    if [ "$removed_any" = false ]; then
        echo "    Installed extensions already match myagent — nothing to prune"
    fi

    # Drop the legacy per-install state file: extension pruning no longer reads it.
    if [ -f "$LEGACY_EXT_STATE_FILE" ]; then
        rm -f "$LEGACY_EXT_STATE_FILE"
        echo "    Removed legacy state file $LEGACY_EXT_STATE_FILE (no longer used)"
    fi

    echo ""
    echo "==> Pruning external skills"
    if [ -f "$SKILL_STATE_FILE" ]; then
        if ! command -v npx >/dev/null 2>&1; then
            echo "    npx is required to prune external skills."
            exit 1
        fi

        new_tmp_file installed_skill_names
        npx -y skills ls -g --json | sed -n 's/.*"name":[[:space:]]*"\([^"]*\)".*/\1/p' > "$installed_skill_names"

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
                if npx -y skills remove -g "$skill_name" -y; then
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
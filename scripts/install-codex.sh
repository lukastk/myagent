#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_CONFIG="$REPO_ROOT/mcp.json"
STATE_DIR="$REPO_ROOT/.install-state"
CODEX_MCP_STATE_FILE="$STATE_DIR/codex_mcp.txt"

PRUNE=false

usage() {
    cat <<EOF
Usage: scripts/install-codex.sh [--prune]

Applies myagent's mcp.json servers to Codex's user-level MCP configuration.
Codex CLI, the Codex IDE extension, and the Codex desktop app share that config.

Options:
  --prune      Remove previously myagent-managed MCP servers no longer listed.
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

if ! command -v codex >/dev/null 2>&1; then
    echo "Error: 'codex' CLI not found in PATH. Install Codex first." >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: 'python3' is required to parse mcp.json." >&2
    exit 1
fi

mkdir -p "$STATE_DIR"
tmp_desired="$(mktemp)"
tmp_state="$(mktemp)"
cleanup() {
    rm -f "$tmp_desired" "$tmp_state"
}
trap cleanup EXIT

echo "==> Applying MCP servers to Codex (user config)"

if [ ! -f "$MCP_CONFIG" ]; then
    echo "    No mcp.json found, skipping."
    : > "$tmp_desired"
else
    # Validate every entry before mutating Codex config, then use argv-only
    # subprocess calls. cwd is represented by a shell wrapper because the
    # installed `codex mcp add` CLI has no cwd flag even though config.toml does.
    python3 - "$MCP_CONFIG" "$tmp_desired" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys

config_path, desired_path = sys.argv[1:]
with open(config_path, encoding="utf-8") as config_file:
    data = json.load(config_file)

operations = []
for name, cfg in (data.get("mcpServers") or {}).items():
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise SystemExit(f"Invalid Codex MCP server name: {name!r}")
    if not isinstance(cfg, dict):
        raise SystemExit(f"MCP server {name!r} must be an object")

    add_argv = ["codex", "mcp", "add", name]
    url = cfg.get("url")
    if url:
        if cfg.get("headers"):
            raise SystemExit(
                f"Codex installer cannot represent static headers for HTTP MCP server {name!r} "
                "through `codex mcp add`; add explicit support before declaring them"
            )
        add_argv += ["--url", str(url)]
        token_env = cfg.get("bearerTokenEnvVar") or cfg.get("bearer_token_env_var")
        if token_env:
            add_argv += ["--bearer-token-env-var", str(token_env)]
    else:
        command = cfg.get("command")
        if not isinstance(command, str) or not command:
            raise SystemExit(f"stdio MCP server {name!r} is missing a command")
        args = cfg.get("args") or []
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise SystemExit(f"stdio MCP server {name!r} args must be strings")
        env = cfg.get("env") or {}
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise SystemExit(f"stdio MCP server {name!r} env must map strings to strings")
        for key, value in sorted(env.items()):
            add_argv += ["--env", f"{key}={value}"]

        server_argv = [command, *args]
        cwd = cfg.get("cwd")
        if cwd:
            if not isinstance(cwd, str):
                raise SystemExit(f"stdio MCP server {name!r} cwd must be a string")
            expanded_cwd = os.path.expandvars(os.path.expanduser(cwd))
            wrapped = f"cd {shlex.quote(expanded_cwd)} && exec"
            for value in server_argv:
                wrapped += " " + shlex.quote(value)
            server_argv = ["sh", "-c", wrapped]
        add_argv += ["--", *server_argv]

    operations.append((name, add_argv))

with open(desired_path, "w", encoding="utf-8") as desired_file:
    for name, _ in operations:
        desired_file.write(name + "\n")

for name, add_argv in operations:
    print(f"    {name}", flush=True)
    subprocess.run(
        ["codex", "mcp", "remove", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    result = subprocess.run(add_argv, stdout=subprocess.DEVNULL, check=False)
    if result.returncode:
        raise SystemExit(f"Failed to add Codex MCP server {name!r} (exit {result.returncode})")
PY
fi

if [ "$PRUNE" = true ]; then
    echo ""
    echo "==> Pruning stale Codex MCP servers"
    removed_any=false
    if [ -f "$CODEX_MCP_STATE_FILE" ]; then
        while IFS= read -r name || [ -n "$name" ]; do
            [ -z "$name" ] && continue
            if grep -Fxq -- "$name" "$tmp_desired"; then
                continue
            fi
            echo "    removing $name"
            codex mcp remove "$name" >/dev/null
            removed_any=true
        done < "$CODEX_MCP_STATE_FILE"
    fi
    if [ "$removed_any" = false ]; then
        echo "    No stale Codex MCP servers"
    fi
    cp "$tmp_desired" "$tmp_state"
else
    if [ -f "$CODEX_MCP_STATE_FILE" ]; then
        cat "$CODEX_MCP_STATE_FILE" "$tmp_desired" | sort -u > "$tmp_state"
    else
        sort -u "$tmp_desired" > "$tmp_state"
    fi
fi
mv "$tmp_state" "$CODEX_MCP_STATE_FILE"

echo ""
echo "==> Done. Restart Codex clients to pick up MCP server changes."

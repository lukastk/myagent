#!/usr/bin/env bash
set -euo pipefail

FD_VERSION="${FD_VERSION:-10.3.0}"

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

    local mise_shims_dir="$HOME/.local/share/mise/shims"
    local fd_candidates=()
    mapfile -t fd_candidates < <(which -a fd 2>/dev/null | awk '!seen[$0]++')
    for candidate in "${fd_candidates[@]}"; do
        [ -n "$candidate" ] || continue
        [ "$candidate" = "$pi_fd_path" ] && continue
        [[ "$candidate" == "$mise_shims_dir/"* ]] && continue
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

configure_pi_fd_binary

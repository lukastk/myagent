#!/usr/bin/env bash
# Sharp has no Android prebuild: use Termux libvips and its native Node headers.
# Kept separate so this dependency step can be run without deploying other clients.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: bash scripts/install-web-dependencies.sh <web-extension-directory>" >&2
    exit 64
fi
cd -- "$1"
platform="$(node -p 'process.platform')"

if [ "$platform" = android ]; then
    : "${PREFIX:?Termux PREFIX is required to build Sharp on Android}"
    if [ ! -f "$PREFIX/include/node/common.gypi" ]; then
        echo "Missing Termux Node headers: $PREFIX/include/node/common.gypi" >&2
        exit 1
    fi
    # No pkg upgrade/update, and do not upgrade explicitly requested installed
    # packages. apt may still need a related dependency revision for libvips.
    apt-get install -y --no-upgrade libvips clang make python pkg-config
    pkg-config --modversion vips-cpp
    # Use Termux's patched headers, not upstream Android/NDK cross-build headers.
    export npm_package_config_node_gyp_nodedir="$PREFIX"
fi

npm install --omit=dev

if [ "$platform" = android ]; then
    # npm install does not rerun Sharp's hook in an already-installed tree.
    # Rebuild explicitly to repair that tree and relink after libvips changes.
    npm rebuild sharp --foreground-scripts
fi

# Sharp 0.33's install check can exit successfully without building anything.
# Verify the real native import and image pipeline rather than trusting npm exit 0.
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import sharp from 'sharp';
const image = await sharp({
    create: { width: 4, height: 2, channels: 3, background: '#336699' },
}).resize(2, 1).png().toBuffer();
const meta = await sharp(image).metadata();
assert.equal(meta.format, 'png');
assert.equal(meta.width, 2);
assert.equal(meta.height, 1);
console.log(`Sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}: image probe passed`);
JS

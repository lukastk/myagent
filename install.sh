#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
EXTENSIONS_LIST="$SCRIPT_DIR/external_extensions.txt"

echo "==> Installing local extensions"

mkdir -p "$EXTENSIONS_DIR"

# Symlink each extension folder into ~/.pi/agent/extensions/
for ext_dir in "$SCRIPT_DIR"/extensions/*/; do
	ext_name="$(basename "$ext_dir")"
	target="$EXTENSIONS_DIR/$ext_name"

	if [ -L "$target" ]; then
		existing="$(readlink "$target")"
		if [ "$existing" = "$ext_dir" ]; then
			echo "    $ext_name (already linked)"
			continue
		fi
		echo "    $ext_name (updating symlink)"
		rm "$target"
	elif [ -e "$target" ]; then
		echo "    $ext_name (SKIPPED — non-symlink already exists at $target)"
		continue
	else
		echo "    $ext_name"
	fi

	ln -s "$ext_dir" "$target"

	# Install npm dependencies if the extension has a package.json
	if [ -f "$ext_dir/package.json" ]; then
		echo "      installing npm dependencies..."
		(cd "$ext_dir" && npm install --omit=dev)
	fi
done

echo ""
echo "==> Installing external extensions"

if [ ! -f "$EXTENSIONS_LIST" ]; then
	echo "    No external_extensions.txt found, skipping."
else
	while IFS= read -r line || [ -n "$line" ]; do
		# Skip comments and blank lines
		line="$(echo "$line" | sed 's/#.*//' | xargs)"
		[ -z "$line" ] && continue

		echo "    $line"
		pi install "$line"
	done < "$EXTENSIONS_LIST"
fi

echo ""
echo "==> Done. Reload Pi with /reload if it's running."

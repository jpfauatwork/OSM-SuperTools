#!/usr/bin/env bash
# Build a distributable Firefox add-on package for OSM SuperTools.
# Produces web-ext-artifacts/osm-supertools-<version>.zip (also copied as .xpi).
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
OUT_DIR="web-ext-artifacts"
NAME="osm-supertools-${VERSION}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$NAME.zip" "$OUT_DIR/$NAME.xpi"

# Files that make up the extension (manifest must be at the archive root).
zip -r -FS "$OUT_DIR/$NAME.zip" \
  manifest.json \
  background.js \
  content.css \
  topbar.css \
  options.html \
  options.css \
  options.js \
  icons \
  modules \
  -x '*.DS_Store'

# A Firefox add-on package is just a renamed zip.
cp "$OUT_DIR/$NAME.zip" "$OUT_DIR/$NAME.xpi"

echo ""
echo "Built $OUT_DIR/$NAME.zip"
echo "Built $OUT_DIR/$NAME.xpi"

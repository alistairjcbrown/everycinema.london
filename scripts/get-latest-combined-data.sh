#!/usr/bin/env bash
# Adapted from clusterflick/scripts/helpers/get-latest-combined-data.sh
# Downloads the latest published clusterflick combined-data release into ./data-combined/
# so this project is self-contained (no dependency on a sibling repo checkout).
set -euo pipefail

REPO_URL='https://api.github.com/repos/clusterflick/data-combined/releases/latest'
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/data-combined"
mkdir -p "$OUT_DIR"

RESPONSE_LIST=$(curl -sS -L -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$REPO_URL")

for f in $(echo "$RESPONSE_LIST" | grep browser_download | cut -d\" -f4); do
  echo "Getting $f ..."
  curl -sS -L "$f" -o "$OUT_DIR/$(basename "$f")"
done

echo "Done -> $OUT_DIR"

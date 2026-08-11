#!/usr/bin/env bash
# Adapted from clusterflick/scripts/helpers/get-latest-combined-data.sh
# Downloads a published clusterflick combined-data release into ./data-combined/
# so this project is self-contained (no dependency on a sibling repo checkout).
#
# Usage: get-latest-combined-data.sh [RELEASE_TAG]
#   (no argument)  the newest published release — what you want locally
#   RELEASE_TAG    that exact release
#
# CI passes a tag, so the site build and the performance-history windows come from
# the SAME release. Asking for "latest" independently lets the two drift: releases
# land a few times a day, and one arriving between the history job and this download
# leaves the hours between the last closed window and the newer release covered by
# no window at all — and absent from the newer release too, because a release only
# lists FUTURE performances. Those screenings then go missing from the daily totals
# until the window is written. See the gap warning in history.mjs `build`.
#
# Works unauthenticated locally. In CI, set GITHUB_TOKEN to raise the api.github.com
# rate limit (shared runner IPs can otherwise hit the 60/hour anonymous cap).
set -euo pipefail

TAG="${1:-}"
API='https://api.github.com/repos/clusterflick/data-combined/releases'
if [ -n "$TAG" ]; then
  REPO_URL="$API/tags/$TAG"
else
  REPO_URL="$API/latest"
fi
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/data-combined"
mkdir -p "$OUT_DIR"

AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# ${AUTH[@]+"${AUTH[@]}"} rather than "${AUTH[@]}": under `set -u`, bash 3.2 (which
# is what macOS ships) treats expanding an EMPTY array as an unbound variable.
RESPONSE_LIST=$(curl -sS -L ${AUTH[@]+"${AUTH[@]}"} \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$REPO_URL")

# A missing tag answers 404 with a JSON body carrying no download URLs, which would
# otherwise leave the previous download in place and exit 0 — a stale build that
# looks like a clean one.
ASSETS=$(echo "$RESPONSE_LIST" | grep browser_download | cut -d\" -f4 || true)
if [ -z "$ASSETS" ]; then
  echo "No release assets found at $REPO_URL" >&2
  echo "$RESPONSE_LIST" | head -c 400 >&2
  echo >&2
  exit 1
fi

for f in $ASSETS; do
  echo "Getting $f ..."
  curl -sS -L ${AUTH[@]+"${AUTH[@]}"} "$f" -o "$OUT_DIR/$(basename "$f")"
done

echo "Done -> $OUT_DIR"

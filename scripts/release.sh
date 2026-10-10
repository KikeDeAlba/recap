#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

publish=false
for argument in "$@"; do
  case "$argument" in
    --publish) publish=true ;;
    *) echo "usage: scripts/release.sh [--publish]" >&2; exit 64 ;;
  esac
done

version="$(sed -n 's/.*static let version = "\(.*\)".*/\1/p' Sources/RecapCapture/Commands/CaptureCommands.swift)"
asset="Recap-${version}-macos-arm64.zip"

./scripts/bundle.sh

rm -rf dist
mkdir -p dist
ditto -c -k --sequesterRsrc --keepParent build/Recap.app "dist/$asset"
(cd dist && shasum -a 256 "$asset" > "$asset.sha256")
echo "dist/$asset"

if [[ "$publish" == true ]]; then
  if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
    echo "error: publish from main" >&2
    exit 1
  fi
  if gh release view "v$version" >/dev/null 2>&1; then
    gh release upload "v$version" "dist/$asset" "dist/$asset.sha256" --clobber
  else
    gh release create "v$version" "dist/$asset" "dist/$asset.sha256" --target main --title "recap $version" --generate-notes
  fi
fi

#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

configuration="${CONFIGURATION:-release}"
version="$(sed -n 's/.*static let version = "\(.*\)".*/\1/p' Sources/recap/Recap.swift)"
app="build/Recap.app"

swift build -c "$configuration" --product recap
binary="$(swift build -c "$configuration" --show-bin-path)/recap"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/recap"
sed "s/__VERSION__/$version/g" Resources/Info.plist > "$app/Contents/Info.plist"
find Resources -type f ! -name Info.plist -exec cp {} "$app/Contents/Resources/" \;

identity="${RECAP_SIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -n 1)"
fi
if [[ -z "$identity" ]]; then
  identity="-"
  echo "warning: no Apple Development identity found; signing ad-hoc, permissions may be requested again after each build" >&2
fi

codesign --force --sign "$identity" --identifier com.kikedealba.recap "$app"
codesign --verify --strict "$app"
echo "$app ($version, signed with: $identity)"

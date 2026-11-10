#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${MYGO_LITE_REPO:-}" ]]; then
  echo 'Set MYGO_LITE_REPO to a local MyGo Music Lite 0.4.0 or later Git checkout.' >&2
  exit 2
fi
plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/mygo-youtube-host.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT

git -C "$MYGO_LITE_REPO" archive --format=tar HEAD | tar -xf - -C "$verification_dir"
cp "$plugin_dir/test/host/catalog_live_test.go" "$verification_dir/internal/plugin/youtube_live_test.go"
cp "$plugin_dir/test/host/playback_live_test.go" "$verification_dir/internal/player/youtube_live_test.go"
cp "$plugin_dir/test/host/redirect_test.go" "$verification_dir/internal/plugin/youtube_redirect_test.go"
export MYGO_YOUTUBE_PLUGIN="$plugin_dir"
cd "$verification_dir"
# The portable backend's static libraries are outside Git. Copy the local cache,
# then let the archived build recipe verify its hashes or rebuild it.
if [[ -f scripts/build-audio.sh ]]; then
  if [[ -d "$MYGO_LITE_REPO/build/audio/darwin-arm64" ]]; then
    mkdir -p build/audio
    cp -R "$MYGO_LITE_REPO/build/audio/darwin-arm64" build/audio/
  fi
  scripts/build-audio.sh
fi

go test ./internal/plugin -run '^TestYouTube(CatalogLive|Redirect)$' -count=1 -v
if [[ -n "${MYGO_SIGN_IDENTITY:-}" ]]; then
  test_binary="$verification_dir/youtube-player.test"
  entitlements="$verification_dir/youtube-entitlements.plist"
  cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>
PLIST
  go test -c ./internal/player -o "$test_binary"
  signing_args=(--force --options runtime --timestamp --entitlements "$entitlements" --sign "$MYGO_SIGN_IDENTITY")
  if [[ -n "${MYGO_SIGN_KEYCHAIN:-}" ]]; then signing_args+=(--keychain "$MYGO_SIGN_KEYCHAIN"); fi
  codesign "${signing_args[@]}" "$test_binary"
  "$test_binary" -test.run '^TestYouTubePluginLive$' -test.count=1 -test.v
else
  echo 'Native verification uses an unsigned test binary. Set MYGO_SIGN_IDENTITY to test the hardened runtime.'
  go test ./internal/player -run '^TestYouTubePluginLive$' -count=1 -v
fi

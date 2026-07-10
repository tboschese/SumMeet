#!/usr/bin/env bash
# Builds SumMeet.app: the Tauri shell + the Swift recorder, signed.
#
# This is not packaging polish — it's a functional requirement. macOS grants
# Microphone and Screen Recording to the *responsible process*: the first signed
# .app in the spawn chain. A bare `cargo run` binary has no Info.plist and no
# usage descriptions, so the OS denies the microphone silently, with no prompt.
# (Run from a terminal it appears to work, because the terminal app is then the
# responsible process and already holds the grant — which is exactly how this bug
# hid during development.)
#
# The recorder ships inside Contents/MacOS next to the shell, so it inherits the
# app's grants and recorder_path() finds it as a sibling.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
APP="$HERE/build/SumMeet.app"
PROFILE="${1:-debug}"

echo "→ building the Swift recorder"
"$ROOT/apps/macos/recorder/build.sh" >/dev/null

echo "→ building the Tauri shell ($PROFILE)"
pushd "$HERE/src-tauri" >/dev/null
if [ "$PROFILE" = "release" ]; then cargo build --release; else cargo build; fi
popd >/dev/null

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>summeet-desktop</string>
  <key>CFBundleIdentifier</key><string>com.summeet.app</string>
  <key>CFBundleName</key><string>SumMeet</string>
  <key>CFBundleDisplayName</key><string>SumMeet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>SumMeet records your voice alongside the meeting audio, so your own commitments are captured.</string>
  <key>NSCameraUsageDescription</key>
  <string>SumMeet does not use the camera.</string>
</dict>
</plist>
PLIST

cp "$HERE/src-tauri/target/$PROFILE/summeet-desktop" "$APP/Contents/MacOS/"
cp "$ROOT/apps/macos/recorder/build/recorder" "$APP/Contents/MacOS/recorder"
cp "$HERE/src-tauri/icons/icon.png" "$APP/Contents/Resources/icon.png" 2>/dev/null || true

echo "→ signing (ad-hoc, with the bundle's Info.plist)"
# A stable identifier, not the default hash-of-the-path one: TCC keys its grant on
# it, so an unstable identifier means the microphone permission silently resets on
# every rebuild.
codesign --force --sign - --identifier com.summeet.recorder "$APP/Contents/MacOS/recorder"
codesign --force --sign - --identifier com.summeet.app "$APP"

# TCC pins an ad-hoc signature to the binary's cdhash, so a rebuilt app is a
# *different* app to the permission system while still showing the old, matching
# name in System Settings. The user then sees "SumMeet" ticked and gets prompted
# anyway, and no grant ever sticks. Clear our own stale entries so the next launch
# asks once, cleanly. Scoped to our bundle ids; nothing else is touched.
if [ "${SUMMEET_KEEP_TCC:-0}" != "1" ]; then
  echo "→ clearing stale TCC entries for com.summeet.* (ad-hoc signatures are cdhash-pinned)"
  for id in com.summeet.app com.summeet.recorder; do
    for svc in ScreenCapture Microphone; do
      tccutil reset "$svc" "$id" >/dev/null 2>&1 || true
    done
  done
fi

echo "✓ $APP"
echo "  open with:  open \"$APP\""
echo "  macOS will ask for Screen Recording + Microphone on the first recording."

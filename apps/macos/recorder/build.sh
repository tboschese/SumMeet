#!/usr/bin/env bash
# Builds the native recorder into a signed .app bundle.
#
# The bundle is not cosmetic: macOS grants Screen Recording and Microphone access
# per code-signed bundle identifier. A bare binary inherits whatever the launching
# terminal was granted — fragile, invisible to the user, and impossible to revoke
# cleanly. Ship signed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HERE/build/SumMeet Recorder.app}"
BIN="$HERE/build/recorder"

mkdir -p "$HERE/build" "$APP/Contents/MacOS"

# The recorder also runs as a plain executable inside SumMeet.app/Contents/MacOS,
# where there is no Info.plist of its own. TCC reads the usage description from the
# binary's __TEXT,__info_plist section; without it macOS denies the microphone
# silently — no prompt, no orange indicator, no error. Embed it in the Mach-O.
cat > "$HERE/build/embedded-info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.summeet.recorder</string>
  <key>CFBundleName</key><string>SumMeet Recorder</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>SumMeet records your voice alongside the meeting audio, so your own commitments are captured.</string>
</dict>
</plist>
PLIST

echo "→ compiling"
swiftc -O -parse-as-library "$HERE/recorder.swift" -o "$BIN" \
  -framework ScreenCaptureKit -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$HERE/build/embedded-info.plist"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>recorder</string>
  <key>CFBundleIdentifier</key><string>com.summeet.recorder</string>
  <key>CFBundleName</key><string>SumMeet Recorder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>SumMeet records your voice alongside the meeting audio, so your own commitments are captured.</string>
</dict>
PLIST
echo "</plist>" >> "$APP/Contents/Info.plist"

cp "$BIN" "$APP/Contents/MacOS/recorder"

echo "→ signing (ad-hoc)"
codesign --force --sign - --options runtime "$APP" 2>/dev/null || codesign --force --sign - "$APP"

echo "✓ $APP"
echo "  run: \"$APP/Contents/MacOS/recorder\" out.wav 5"

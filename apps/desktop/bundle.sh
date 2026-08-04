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

# Unlock the signing keychain up front, so a keychain locked by sleep doesn't fail the
# build with errSecInternalComponent. If the dedicated signing keychain exists (from
# setup-signing.sh) we unlock *that* non-interactively with its known password — the
# permanent fix, no login keychain and no prompt ever. Otherwise fall back to the login
# keychain (unlocks if already open, prompts once via GUI if truly locked).
DEDICATED_KEYCHAIN="$HOME/Library/Keychains/summeet-signing.keychain-db"
if [ -f "$DEDICATED_KEYCHAIN" ]; then
  security unlock-keychain -p "summeet-local-signing" "$DEDICATED_KEYCHAIN" 2>/dev/null || true
elif security find-identity -v -p codesigning 2>/dev/null | grep -q "SumMeet Dev"; then
  security unlock-keychain "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null || true
fi

echo "→ building the Swift recorder"
"$ROOT/apps/macos/recorder/build.sh" >/dev/null

# The panel is exported to static files and compiled into the shell binary, so the app
# serves its own UI. No Next server, no port 3000, nothing to leave orphaned.
echo "→ exporting the web panel"
(cd "$ROOT" && pnpm --filter @summeet/web build >/dev/null)
test -f "$ROOT/apps/web/out/index.html" || { echo "✗ panel export produced no out/" >&2; exit 1; }

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
  <!--
    The dev backend runs from the repo, which lives under ~/Documents. Without this
    key macOS cannot even show the Files-and-Folders prompt, and the child process
    hangs forever inside getcwd() — a silent block, no error, no dialog. Diagnosed
    by sampling a stuck `pnpm dev`: uv_cwd -> __getcwd -> open$NOCANCEL.
  -->
  <key>NSDocumentsFolderUsageDescription</key>
  <string>SumMeet runs its local server from the project folder while you develop it.</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>SumMeet reads recordings you save to the Desktop, if you upload them.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>SumMeet reads recordings you save to Downloads, if you upload them.</string>
</dict>
</plist>
PLIST

cp "$HERE/src-tauri/target/$PROFILE/summeet-desktop" "$APP/Contents/MacOS/"
cp "$ROOT/apps/macos/recorder/build/recorder" "$APP/Contents/MacOS/recorder"

# The Dock reads .icns and nothing else — a PNG in Resources is silently ignored and
# you get the generic app icon instead. icons.py draws both this and the menu-bar
# template; regenerate if it is missing.
if [ ! -f "$HERE/src-tauri/icons/icon.icns" ]; then
  echo "→ drawing icons"
  python3 "$HERE/icons.py" >/dev/null
fi
cp "$HERE/src-tauri/icons/icon.icns" "$APP/Contents/Resources/icon.icns"

# The API travels inside the app: Node, the bundled server, Prisma's native engine and a
# migrated empty database. Without this the app needs pnpm, tsx and the repo to exist.
echo "→ packaging the API"
"$HERE/bundle-api.sh" "$APP"

# Sign with a stable identity when one exists, so TCC grants survive rebuilds.
#
# An ad-hoc signature pins the grant to the binary's cdhash, which changes on every
# build: the user re-approves Screen Recording and the microphone every single time,
# while System Settings still shows a ticked "SumMeet" that no longer matches. A
# self-signed certificate makes the code requirement key on the *certificate* instead
# of the hash, so the grant sticks. Create it once with apps/desktop/setup-signing.sh.
IDENTITY="SumMeet Dev"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "→ signing with '$IDENTITY' (grants survive rebuilds)"
  SIGN=(--sign "$IDENTITY")
  STABLE=1
else
  echo "→ signing ad-hoc — run apps/desktop/setup-signing.sh so permissions stop resetting"
  SIGN=(--sign -)
  STABLE=0
fi

# The recorder shares the app's identity so it is one subject to TCC, not two: as its
# own signed identifier it needed its own Screen Recording grant, a second entry to
# approve. Same certificate, same requirement, one permission.
#
# Trust codesign's own exit code — that is the authority on whether signing worked. The
# old check re-read the signature with `codesign -dvv | grep` right after signing and
# often saw a stale view, so it reported failure and retried four times on a bundle that
# was, in fact, correctly signed. A genuine failure (locked keychain →
# errSecInternalComponent) is a non-zero exit, which this catches directly.
sign_one() {
  codesign --force "${SIGN[@]}" --identifier com.summeet.app "$1"
}

if [ "$STABLE" = "1" ]; then
  if ! sign_one "$APP/Contents/MacOS/recorder" || ! sign_one "$APP"; then
    echo "✗ codesign with '$IDENTITY' failed — the login keychain is probably locked." >&2
    echo "  Unlock it: security unlock-keychain \"\$HOME/Library/Keychains/login.keychain-db\"" >&2
    echo "  (or run any Keychain Access action), then rebuild." >&2
    exit 1
  fi
  # Belt and braces: a signed bundle must also verify.
  codesign --verify --deep --strict "$APP" || { echo "✗ signature failed to verify" >&2; exit 1; }
else
  sign_one "$APP/Contents/MacOS/recorder"
  sign_one "$APP"
fi

# Ad-hoc only: the cdhash moved, so the old grant is dead weight that still shows as
# ticked. Clear it so the next launch prompts cleanly. With a stable identity the
# grant is meant to persist, so leave it alone.
if [ "$STABLE" = "0" ] && [ "${SUMMEET_KEEP_TCC:-0}" != "1" ]; then
  echo "→ clearing stale TCC entries (ad-hoc signatures are cdhash-pinned)"
  for id in com.summeet.app com.summeet.recorder; do
    for svc in ScreenCapture Microphone SystemPolicyDocumentsFolder; do
      tccutil reset "$svc" "$id" >/dev/null 2>&1 || true
    done
  done
fi

# The Dock caches an app's icon by path. A rebuilt bundle keeps the old picture until
# its mtime changes and the Dock is restarted — which looks exactly like the icon
# never having been updated.
touch "$APP"
killall Dock 2>/dev/null || true

echo "✓ $APP"
echo "  open with:  open \"$APP\""
echo "  macOS will ask for Screen Recording + Microphone on the first recording."

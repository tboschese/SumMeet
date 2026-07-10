# macOS capture spike — ScreenCaptureKit

Answers the question SPEC §13.5 said to answer *before* committing to a desktop
stack: **can we capture system audio on macOS without a virtual audio driver?**

**Yes.** ScreenCaptureKit (macOS 13+) delivers the system audio mix directly.
No BlackHole, no kernel extension, no driver install for the user.

## Result

| Scenario | RMS | Verdict |
|---|---|---|
| Nothing playing (control) | 0.000000 | silence, as expected |
| `afplay` (headless process) | 0.000000 | **not captured** |
| QuickTime (app with a window) | 0.090360 | **captured** ✅ |

## The finding that matters

The capture filter is built from **displays / on-screen windows**, so audio from
processes with no window is not included. Every real target (Meet in a browser,
Zoom, Teams, Slack huddles) has a window, so this doesn't affect the product —
but it does mean a headless CLI can't be used to test the capture path.

## Run it

```bash
swiftc -O -parse-as-library spike.swift -o spike \
  -framework ScreenCaptureKit -framework AVFoundation
```

It must run from a signed .app bundle: macOS grants Screen Recording per bundle
identifier, and a bare binary inherits the terminal's (or the editor's)
permission, which is both fragile and something we shouldn't ask a user for.

```bash
APP="SumMeet Spike.app"
mkdir -p "$APP/Contents/MacOS" && cp spike "$APP/Contents/MacOS/"
# Info.plist with CFBundleExecutable=spike, CFBundleIdentifier=com.summeet.spike
codesign --force --sign - "$APP"
"$APP/Contents/MacOS/spike" out.wav 5
```

## What this unlocks

The native app records **any** meeting — browser or desktop client — with no
extension and no tab picker. Next: mix this with the microphone into the stereo
layout the pipeline expects (left = system/others, right = mic/you), which is
what gives us speaker attribution for free (SPEC A1).

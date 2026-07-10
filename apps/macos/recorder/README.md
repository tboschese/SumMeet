# Native recorder (macOS)

Records a meeting with **no browser, no extension, no virtual audio driver**:

- **system audio** (everyone else) → **left** channel
- **microphone** (you) → **right** channel

That layout is what gives the pipeline free speaker attribution (SPEC A1). It is
declared on upload as `channelLayout=summeet-stereo-v1`; without the declaration
the server refuses to infer speakers, because a stereo file alone carries no such
meaning (a panned podcast would otherwise be labelled "You").

## Why one stream, not two

Both sources come from a single `SCStream` (macOS 15 `captureMicrophone`), so they
share one clock and cannot drift apart. Capturing the mic separately via
AVAudioEngine would mean reconciling two clocks — and drift silently corrupts the
speaker attribution rather than failing loudly.

The recorder **refuses to write a file when only one source captured**, instead of
emitting a mono file the pipeline would misread.

## Build & run

```bash
./build.sh                                   # compiles + signs the .app
"build/SumMeet Recorder.app/Contents/MacOS/recorder" out.wav 6
```

Signing matters: macOS grants Screen Recording and Microphone **per bundle id**.
A bare binary inherits the launching terminal's grant — fragile and invisible.

Needs `ffmpeg` on `PATH` (it joins the two sources into the stereo layout).

## Measured

Playing audio in QuickTime while recording:

```
system: RMS 0.118810   ← left
mic:    RMS 0.054814   ← right (room/echo only; nobody spoke)
```

Through the pipeline, the spoken line was attributed to `others` and **not** to
`self` — the mic had picked up speaker bleed, and the dominance ratio correctly
refused to call it "you". Ambiguous spans abstain (`null`) rather than guess.

## Known limits

- Audio from **windowless processes** is not captured (ScreenCaptureKit filters by
  display/on-screen windows). Every meeting client has a window; a headless CLI
  can't be used to test the capture path.
- macOS 15+ (for `captureMicrophone`).

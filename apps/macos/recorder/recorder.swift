// SumMeet native recorder (SPEC A7).
//
// Captures the meeting with no browser, no extension and no virtual audio driver:
//   • system audio  (everyone else)  -> LEFT  channel
//   • microphone    (you)            -> RIGHT channel
//
// Both come from a single SCStream (macOS 15+ `captureMicrophone`), so they share
// one clock and can't drift apart — which is what makes the stereo layout, and
// therefore the free speaker attribution (SPEC A1), trustworthy.
//
//   recorder <out.wav> [seconds]     # omit seconds to record until SIGINT
//
// The two sources are written to separate temp WAVs and joined into the stereo
// layout with ffmpeg at the end. Mixing live would mean hand-rolling ring buffers
// aligned on presentation timestamps; ffmpeg is already a project dependency and
// the join is exact because the clocks match.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Channel writer

/// Writes one source to its own WAV and tracks loudness, so "it ran" can never be
/// mistaken for "it captured".
final class ChannelWriter {
    private let url: URL
    private var file: AVAudioFile?
    private(set) var sumSquares: Double = 0
    private(set) var sampleCount = 0
    private(set) var peak: Float = 0
    /// Energy since the last takeLevel(), for the live meter.
    private var windowSumSquares: Double = 0
    private var windowCount = 0
    private let lock = NSLock()

    init(url: URL) { self.url = url }

    var rms: Double {
        sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0
    }
    var wroteAnything: Bool { sampleCount > 0 }

    /// RMS since the previous call, then reset. Recording blind is how every
    /// capture bug in this project survived to reach the user: report as we go.
    func takeLevel() -> Double {
        lock.lock()
        defer { lock.unlock() }
        let level = windowCount > 0 ? (windowSumSquares / Double(windowCount)).squareRoot() : 0
        windowSumSquares = 0
        windowCount = 0
        return level
    }

    func append(_ sampleBuffer: CMSampleBuffer) {
        guard sampleBuffer.isValid,
              let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)?.pointee,
              let format = AVAudioFormat(streamDescription: [asbd]) else { return }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        pcm.frameLength = frames

        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frames),
            into: pcm.mutableAudioBufferList) == noErr else { return }

        lock.lock()
        defer { lock.unlock() }

        if let data = pcm.floatChannelData {
            var blockSumSquares: Double = 0
            for ch in 0..<Int(format.channelCount) {
                let buf = data[ch]
                for i in 0..<Int(frames) {
                    let v = buf[i]
                    blockSumSquares += Double(v * v)
                    peak = max(peak, abs(v))
                }
            }
            let n = Int(frames) * Int(format.channelCount)
            sumSquares += blockSumSquares
            sampleCount += n
            windowSumSquares += blockSumSquares
            windowCount += n
        }

        if file == nil {
            file = try? AVAudioFile(forWriting: url, settings: format.settings,
                                    commonFormat: .pcmFormatFloat32,
                                    interleaved: format.isInterleaved)
        }
        try? file?.write(from: pcm)
    }

    func close() { lock.lock(); file = nil; lock.unlock() }
}

// MARK: - Capture

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let system: ChannelWriter
    let mic: ChannelWriter

    init(systemURL: URL, micURL: URL) {
        system = ChannelWriter(url: systemURL)
        mic = ChannelWriter(url: micURL)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        switch type {
        case .audio: system.append(sampleBuffer)
        case .microphone: mic.append(sampleBuffer)
        default: break // .screen — we ask for the smallest possible frame and drop it
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        err("stream stopped: \(error.localizedDescription)")
    }
}

// MARK: - Helpers

/// Mirrors stderr into a persistent log. The recorder runs as a child of the
/// desktop shell, where nobody sees its stderr — and every capture bug so far has
/// been invisible rather than loud.
let logURL: URL? = {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/SumMeet")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("recorder.log")
    if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    return url
}()

/// Unbuffered stdout. Swift's `print` is block-buffered when stdout is a pipe, so
/// the live levels would arrive in one burst at exit — useless for a meter.
func out(_ s: String) {
    FileHandle.standardOutput.write("\(s)\n".data(using: .utf8)!)
}

func err(_ s: String) {
    FileHandle.standardError.write("\(s)\n".data(using: .utf8)!)
    guard let logURL, let h = try? FileHandle(forWritingTo: logURL) else { return }
    defer { try? h.close() }
    try? h.seekToEnd()
    let stamp = ISO8601DateFormatter().string(from: Date())
    try? h.write(contentsOf: "\(stamp) \(s)\n".data(using: .utf8)!)
}

/// ScreenCaptureKit's `captureMicrophone` does *not* request microphone access on
/// our behalf: it just yields nothing useful if we lack it. No prompt, no orange
/// indicator, no error — which is precisely the failure we shipped. Ask for the
/// grant ourselves, and treat "denied" as fatal rather than recording half a
/// meeting.
@available(macOS 15.0, *)
func requireMicrophone() async {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        err("microphone: authorized")
    case .notDetermined:
        err("microphone: requesting access…")
        if await AVCaptureDevice.requestAccess(for: .audio) {
            err("microphone: granted")
        } else {
            err("microphone: DENIED by the user")
            out("MIC_DENIED=1")
            exit(6)
        }
    case .denied, .restricted:
        err("""
            MICROPHONE ACCESS DENIED.
            Open System Settings → Privacy & Security → Microphone and enable SumMeet.
            If SumMeet is not listed, you launched the bare binary: macOS grants the
            microphone to the responsible process, which must be a signed .app bundle.
            Build it with apps/desktop/bundle.sh and launch SumMeet.app.
            """)
        out("MIC_DENIED=1")
        exit(6)
    @unknown default:
        err("microphone: unknown authorization status")
    }
}

/// Same story as the microphone: SCShareableContent throws a localised, opaque
/// "user declined TCC" if Screen Recording is missing. Ask up front, and explain
/// the ad-hoc-signing catch — TCC keys the grant to the binary's cdhash, so every
/// rebuild looks like a brand-new app and silently loses the permission.
func requireScreenRecording() {
    if CGPreflightScreenCaptureAccess() {
        err("screen recording: authorized")
        return
    }
    err("screen recording: requesting access…")
    if CGRequestScreenCaptureAccess() {
        err("screen recording: granted")
        return
    }
    err("""
        SCREEN RECORDING ACCESS DENIED.
        System audio is captured through ScreenCaptureKit, so SumMeet needs
        "Screen & System Audio Recording" — it never records the screen (the video
        plane is 2x2 pixels and thrown away).
        Enable SumMeet in System Settings → Privacy & Security → Screen & System
        Audio Recording, then reopen the app.
        Note: rebuilding the app invalidates the grant (ad-hoc signatures are keyed
        by binary hash); remove the stale SumMeet entry and add the new one.
        """)
    out("SCREEN_DENIED=1")
    exit(8)
}

/// Zero-lag Pearson correlation between the two captured sources, over the first
/// `limit` frames. If the microphone output is secretly a copy of the system mix,
/// this reads ~1.0. Real speech (even with speaker bleed, which arrives delayed)
/// stays well below that.
func correlation(_ a: URL, _ b: URL, limitFrames: Int = 48_000 * 30) -> Double? {
    func mono(_ url: URL) -> [Double]? {
        guard let f = try? AVAudioFile(forReading: url) else { return nil }
        let frames = AVAudioFrameCount(min(Int(f.length), limitFrames))
        guard frames > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: frames),
              (try? f.read(into: buf, frameCount: frames)) != nil,
              let data = buf.floatChannelData else { return nil }
        let ch = Int(f.processingFormat.channelCount)
        let n = Int(buf.frameLength)
        return (0..<n).map { i in
            var s = 0.0
            for c in 0..<ch { s += Double(data[c][i]) }
            return s / Double(ch)
        }
    }
    guard let x = mono(a), let y = mono(b) else { return nil }
    let n = min(x.count, y.count)
    guard n > 4_800 else { return nil } // < 0.1 s: nothing to conclude

    let mx = x.prefix(n).reduce(0, +) / Double(n)
    let my = y.prefix(n).reduce(0, +) / Double(n)
    var num = 0.0, dx = 0.0, dy = 0.0
    for i in 0..<n {
        let a = x[i] - mx, b = y[i] - my
        num += a * b; dx += a * a; dy += b * b
    }
    guard dx > 0, dy > 0 else { return nil }
    return num / (dx * dy).squareRoot()
}

/// Joins the two mono/stereo sources into the layout the pipeline expects:
/// left = system (others), right = mic (you). See CHANNEL_OTHERS / CHANNEL_SELF.
func joinStereo(system: URL, mic: URL, out: URL) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = [
        "ffmpeg", "-y", "-v", "error",
        "-i", system.path,
        "-i", mic.path,
        "-filter_complex",
        "[0:a]pan=mono|c0=0.5*c0+0.5*c1[l];[1:a]pan=mono|c0=c0[r];[l][r]join=inputs=2:channel_layout=stereo[a]",
        "-map", "[a]", "-ar", "48000", out.path,
    ]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
        throw NSError(domain: "ffmpeg", code: Int(p.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: "ffmpeg join failed"])
    }
}

// MARK: - Upload

/// POSTs the recording to the local API, declaring the channel layout. Only our
/// recorders may declare it: the server refuses to infer speakers otherwise, so a
/// stranger's panned upload can never be attributed to "You".
func upload(file: URL, apiBase: String, title: String) throws -> String {
    let boundary = "summeet-\(UUID().uuidString)"
    var body = Data()

    func field(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(value)\r\n".data(using: .utf8)!)
    }

    field("title", title)
    field("channelLayout", SUMMEET_STEREO_LAYOUT)

    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
    body.append(try Data(contentsOf: file))
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

    var req = URLRequest(url: URL(string: "\(apiBase)/api/meetings")!)
    req.httpMethod = "POST"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    req.timeoutInterval = 300

    var result: Result<String, Error>!
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.uploadTask(with: req, from: body) { data, response, error in
        defer { done.signal() }
        if let error { result = .failure(error); return }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code), let data else {
            let msg = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
            result = .failure(NSError(domain: "upload", code: code,
                                      userInfo: [NSLocalizedDescriptionKey: "HTTP \(code): \(msg)"]))
            return
        }
        let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])??["id"] as? String
        result = id.map { .success($0) } ?? .failure(NSError(
            domain: "upload", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "response had no meeting id"]))
    }.resume()
    done.wait()
    return try result.get()
}

/// Kept in sync by hand with SUMMEET_STEREO_LAYOUT in packages/core/src/media.ts.
let SUMMEET_STEREO_LAYOUT = "summeet-stereo-v1"

// MARK: - Main

@main
struct Main {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        func take(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            let v = args[i + 1]
            args.removeSubrange(i...(i + 1))
            return v
        }
        let apiBase = take("--api")
        let title = take("--title") ?? "Meeting"

        guard let outPath = args.first else {
            err("usage: recorder <out.wav> [seconds] [--api URL] [--title T]")
            exit(64)
        }
        let outURL = URL(fileURLWithPath: outPath)
        let seconds: Double? = args.count > 1 ? Double(args[1]) : nil

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("summeet-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let sysURL = tmp.appendingPathComponent("system.wav")
        let micURL = tmp.appendingPathComponent("mic.wav")
        // Diagnostics: keep the un-joined sources to inspect each channel alone.
        let keepTemp = ProcessInfo.processInfo.environment["SUMMEET_KEEP_TEMP"] == "1"
        defer { if !keepTemp { try? FileManager.default.removeItem(at: tmp) } }
        if keepTemp { err("keeping temp sources in \(tmp.path)") }

        guard #available(macOS 15.0, *) else {
            err("needs macOS 15+ (SCStream microphone capture)")
            exit(1)
        }

        requireScreenRecording()
        await requireMicrophone()

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { err("no display"); exit(2) }

            let filter = SCContentFilter(display: display, excludingApplications: [],
                                         exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.captureMicrophone = true
            config.sampleRate = 48_000
            config.channelCount = 2
            // Audio-only: keep the mandatory video plane as small as allowed.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let rec = Recorder(systemURL: sysURL, micURL: micURL)
            let stream = SCStream(filter: filter, configuration: config, delegate: rec)
            try stream.addStreamOutput(rec, type: .audio,
                                       sampleHandlerQueue: DispatchQueue(label: "sys"))
            try stream.addStreamOutput(rec, type: .microphone,
                                       sampleHandlerQueue: DispatchQueue(label: "mic"))
            try await stream.startCapture()
            err("recording… (system -> left, mic -> right)")

            // Live meter: the shell polls this to show the user, while recording,
            // that both sources are actually alive. Every capture failure in this
            // project was silent until the transcript came back wrong.
            let meter = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    out(String(format: "LEVEL sys=%.5f mic=%.5f",
                               rec.system.takeLevel(), rec.mic.takeLevel()))
                }
            }
            defer { meter.cancel() }

            if let seconds {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            } else {
                // Record until the shell (or the app) asks us to stop.
                let sig = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
                signal(SIGINT, SIG_IGN)
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    sig.setEventHandler { c.resume() }
                    sig.resume()
                }
            }

            try await stream.stopCapture()
            try? await Task.sleep(nanoseconds: 300_000_000) // let writers flush
            rec.system.close()
            rec.mic.close()

            err(String(format: "  system: RMS %.6f peak %.4f (%d samples)",
                       rec.system.rms, rec.system.peak, rec.system.sampleCount))
            err(String(format: "  mic:    RMS %.6f peak %.4f (%d samples)",
                       rec.mic.rms, rec.mic.peak, rec.mic.sampleCount))

            guard rec.system.wroteAnything || rec.mic.wroteAnything else {
                err("captured nothing"); exit(3)
            }
            // Without both sources there is no stereo layout to build, and the
            // pipeline would silently lose speaker attribution — fail loudly.
            guard rec.system.wroteAnything, rec.mic.wroteAnything else {
                err("only one source captured; refusing to write a misleading mono file")
                exit(4)
            }

            // A denied microphone still delivers buffers — silent ones. Counting
            // samples therefore proves nothing; only the energy does. Bit-exact
            // silence across a whole recording means the OS muted us, not that the
            // room was quiet, so say so instead of shipping a half-recording.
            if rec.mic.peak == 0 {
                err("""
                    MICROPHONE CAPTURED PURE SILENCE.
                    macOS grants the microphone to the responsible process — the first
                    signed .app in the chain. Launch SumMeet.app (apps/desktop/bundle.sh),
                    not the bare binary, and approve the prompt.
                    """)
                out("MIC_SILENT=1")
                exit(5)
            }

            // If the "microphone" track is really the system mix wearing a costume,
            // every segment gets attributed to you — a stranger's words signed with
            // your name. That is worse than no attribution, so refuse to ship it.
            if let r = correlation(sysURL, micURL) {
                err(String(format: "  channel correlation: %.4f", r))
                out(String(format: "CHANNEL_CORRELATION=%.4f", r))
                if abs(r) > 0.95 {
                    err("""
                        MICROPHONE IS A DUPLICATE OF THE SYSTEM AUDIO (r=\(String(format: "%.4f", r))).
                        The stream handed us the system mix on the microphone output, so
                        every word would be attributed to you. Refusing to write.
                        """)
                    out("MIC_DUPLICATE=1")
                    exit(7)
                }
            }

            try joinStereo(system: sysURL, mic: micURL, out: outURL)
            out("OK \(outURL.path)")
            out("SYSTEM_RMS=\(rec.system.rms) MIC_RMS=\(rec.mic.rms)")

            if let apiBase {
                err("uploading to \(apiBase)…")
                let id = try upload(file: outURL, apiBase: apiBase, title: title)
                out("MEETING_ID=\(id)")
                try? FileManager.default.removeItem(at: outURL) // the server owns it now
            }
            exit(0)
        } catch {
            err("ERROR: \(error.localizedDescription)")
            exit(1)
        }
    }
}

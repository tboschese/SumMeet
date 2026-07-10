// SumMeet native recorder (SPEC A7).
//
// Captures the meeting with no browser, no extension and no virtual audio driver:
//   • system audio  (everyone else)  -> LEFT  channel
//   • microphone    (you)            -> RIGHT channel
//
// The system audio comes from ScreenCaptureKit. The microphone does NOT: measured
// against a Samsung USB-C headset, SCStreamConfiguration.captureMicrophone yields a
// flat -40 dB hiss (peak/valley ratio 1.2) while the very same device, read through
// CoreAudio, delivers speech at full scale. It fails silently, which is the worst way
// to fail, so the mic is captured with AVCaptureSession instead.
//
// That costs us the single shared clock the two channels used to have. The channels
// are therefore length-matched at join time, and the drift is logged — a few
// milliseconds over a meeting, against 100 ms attribution windows.
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
func describe(_ f: AVAudioFormat) -> String {
    let depth: String
    switch f.commonFormat {
    case .pcmFormatFloat32: depth = "float32"
    case .pcmFormatFloat64: depth = "float64"
    case .pcmFormatInt16: depth = "int16"
    case .pcmFormatInt32: depth = "int32"
    default: depth = "other"
    }
    return "\(Int(f.sampleRate))Hz \(f.channelCount)ch \(depth) "
        + (f.isInterleaved ? "interleaved" : "planar")
}

final class ChannelWriter {
    let name: String
    private let url: URL
    private var file: AVAudioFile?
    /// The format the file was opened with. Every later buffer must match it.
    private var fileFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private(set) var convertedBuffers = 0
    private(set) var droppedBuffers = 0
    /// Peak of the buffer as it *arrived*, before any conversion. Separates "the OS
    /// handed us silence" from "we destroyed the signal on the way to disk".
    private(set) var rawPeak: Float = 0
    /// Host-time of the first buffer, and of the end of the last one. Their difference
    /// is how long this source really ran; comparing that to how many samples it wrote
    /// measures the device's own clock against the host's — no cross-device assumption.
    private(set) var firstPTS: Double?
    private(set) var lastPTSEnd: Double?
    private(set) var sumSquares: Double = 0
    private(set) var sampleCount = 0
    private(set) var peak: Float = 0
    /// Energy since the last takeLevel(), for the live meter.
    private var windowSumSquares: Double = 0
    private var windowCount = 0
    private let lock = NSLock()

    init(name: String, url: URL) { self.name = name; self.url = url }

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
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        if pts.isFinite {
            let dur = CMSampleBufferGetDuration(sampleBuffer).seconds
            lock.lock()
            if firstPTS == nil { firstPTS = pts }
            lastPTSEnd = pts + (dur.isFinite ? dur : 0)
            lock.unlock()
        }
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

        append(pcm)
    }

    /// Split out from the CMSampleBuffer path so the format-change handling can be
    /// exercised without a live capture session (see `--selftest`).
    func append(_ pcm: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }

        if file == nil {
            file = try? AVAudioFile(forWriting: url, settings: pcm.format.settings,
                                    commonFormat: .pcmFormatFloat32,
                                    interleaved: pcm.format.isInterleaved)
            // Pin to what the *file* will accept, not to the first buffer: the file
            // is opened as float32 regardless, so an Int16 source would otherwise
            // compare equal to itself and be written into a format it doesn't match.
            fileFormat = file?.processingFormat
            err("  [\(name)] first buffer: \(describe(pcm.format))")
            if let f = fileFormat { err("  [\(name)] file format:   \(describe(f))") }
        }
        guard let file, let fileFormat else { return }

        switch pcm.format.commonFormat {
        case .pcmFormatFloat32:
            if let d = pcm.floatChannelData {
                for ch in 0..<Int(pcm.format.channelCount) {
                    let stride = pcm.format.isInterleaved ? Int(pcm.format.channelCount) : 1
                    let base = pcm.format.isInterleaved ? ch : 0
                    for i in 0..<Int(pcm.frameLength) {
                        rawPeak = max(rawPeak, abs(d[pcm.format.isInterleaved ? 0 : ch][base + i * stride]))
                    }
                }
            }
        case .pcmFormatInt16:
            if let d = pcm.int16ChannelData {
                let chs = Int(pcm.format.channelCount)
                let count = Int(pcm.frameLength) * (pcm.format.isInterleaved ? chs : 1)
                for ch in 0..<(pcm.format.isInterleaved ? 1 : chs) {
                    for i in 0..<count {
                        rawPeak = max(rawPeak, abs(Float(d[ch][i]) / 32768.0))
                    }
                }
            }
        default: break
        }

        // Connecting headphones switches the input device mid-stream and the buffers
        // change shape — a real recording died here, on the `mic` queue. AVAudioFile
        // does not merely fail on a mismatch: AudioToolbox asserts and kills the
        // process (EXC_BREAKPOINT in ExtAudioFile::WriteInputProc), which no `try?`
        // can catch. Convert instead; drop the buffer if even that fails, because a
        // gap in the audio beats losing the whole meeting.
        let toWrite: AVAudioPCMBuffer
        if pcm.format == fileFormat {
            toWrite = pcm
        } else if let converted = convert(pcm, to: fileFormat) {
            if convertedBuffers == 0 {
                err("  [\(name)] converting from \(describe(pcm.format))")
            }
            convertedBuffers += 1
            toWrite = converted
        } else {
            droppedBuffers += 1
            return
        }

        // Measure the converted buffer: it is always float32, so an Int16 source
        // still contributes energy instead of silently reading as pure silence —
        // which the pipeline would have reported as a dead microphone.
        if let data = toWrite.floatChannelData {
            var blockSumSquares: Double = 0
            for ch in 0..<Int(toWrite.format.channelCount) {
                let buf = data[ch]
                for i in 0..<Int(toWrite.frameLength) {
                    let v = buf[i]
                    blockSumSquares += Double(v * v)
                    peak = max(peak, abs(v))
                }
            }
            let n = Int(toWrite.frameLength) * Int(toWrite.format.channelCount)
            sumSquares += blockSumSquares
            sampleCount += n
            windowSumSquares += blockSumSquares
            windowCount += n
        }

        try? file.write(from: toWrite)
    }

    /// Resample/remix a buffer into the format the file was opened with.
    private func convert(_ pcm: AVAudioPCMBuffer, to target: AVAudioFormat) -> AVAudioPCMBuffer? {
        if converter?.inputFormat != pcm.format || converter?.outputFormat != target {
            converter = AVAudioConverter(from: pcm.format, to: target)
        }
        guard let converter else { return nil }

        let ratio = target.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return nil
        }

        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return pcm
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }

    func close() { lock.lock(); file = nil; lock.unlock() }
}

// MARK: - Microphone (AVCaptureSession, not ScreenCaptureKit)

/// ScreenCaptureKit's microphone output is unreliable across audio devices; CoreAudio
/// is not. Same permission (NSMicrophoneUsageDescription), same buffers, different
/// clock — see the note at the top of this file.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let writer: ChannelWriter
    let deviceName: String

    init?(writer: ChannelWriter) {
        guard let device = AVCaptureDevice.default(for: .audio),
              let input = try? AVCaptureDeviceInput(device: device) else { return nil }
        self.writer = writer
        self.deviceName = device.localizedName
        super.init()

        session.beginConfiguration()
        guard session.canAddInput(input) else { session.commitConfiguration(); return nil }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "mic"))
        guard session.canAddOutput(output) else { session.commitConfiguration(); return nil }
        session.addOutput(output)
        session.commitConfiguration()
    }

    func start() { session.startRunning() }
    func stop() { session.stopRunning() }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        writer.append(sampleBuffer)
    }
}

// MARK: - Capture

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let system: ChannelWriter
    let mic: ChannelWriter

    init(systemURL: URL, micURL: URL) {
        system = ChannelWriter(name: "system", url: systemURL)
        mic = ChannelWriter(name: "mic", url: micURL)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        // Only .audio: the microphone arrives through MicCapture, not through SCStream.
        if type == .audio { system.append(sampleBuffer) }
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

/// Seconds of audio in a file, from its own header.
func durationSeconds(_ url: URL) -> Double {
    guard let f = try? AVAudioFile(forReading: url), f.fileFormat.sampleRate > 0 else { return 0 }
    return Double(f.length) / f.fileFormat.sampleRate
}

/// Joins the two mono/stereo sources into the layout the pipeline expects:
/// left = system (others), right = mic (you). See CHANNEL_OTHERS / CHANNEL_SELF.
///
/// The two sources no longer share a clock (see the note at the top of this file), so
/// the microphone is stretched onto the system's timeline. Padding instead would leave
/// the drift distributed through the meeting, and speaker attribution reads 100 ms
/// windows: a 0.1% drift is 3.6 seconds of misattribution by the end of an hour.
func joinStereo(system: URL, mic: URL, out: URL,
                systemStart: Double?, micStart: Double?, micWallSpan: Double?) throws {
    let systemDuration = durationSeconds(system)
    let micDuration = durationSeconds(mic)
    let systemFilter = "aformat=channel_layouts=mono"
    var micFilter = "aformat=channel_layouts=mono"

    // The mic session opens after the capture stream, so its first sample is late. We
    // deliberately do *not* pad it: a pulsed-tone test showed the stream's first PTS
    // does not mark the instant of the audio inside that buffer, so the measured offset
    // is not the acoustic one. And a constant offset does not spoil attribution anyway
    // — each channel carries its own speech at its own position, and the energy vote
    // reads both channels at the same instant of the mixed file.
    if let s = systemStart, let m = micStart {
        err(String(format: "  start offset: mic +%.0f ms (not corrected — see joinStereo)",
                   (m - s) * 1000))
    }

    // Drift is different: the microphone runs on the device's crystal, not the host's.
    // Comparing how long the mic *ran* (host time) against how much audio it *wrote*
    // measures that clock directly, with no assumption about the other source. Left
    // uncorrected, 0.1% is 3.6 seconds of misattribution by the end of an hour.
    if let wall = micWallSpan, wall > 1, micDuration > 1 {
        let tempo = micDuration / wall
        err(String(format: "  mic clock: wrote %.3fs of audio in %.3fs of host time (%+.3f%%)",
                   micDuration, wall, (tempo - 1) * 100))
        if abs(tempo - 1) > 0.0002 && tempo > 0.95 && tempo < 1.05 {
            micFilter += String(format: ",atempo=%.6f", tempo)
        } else if abs(tempo - 1) >= 0.05 {
            err("  refusing to stretch: that is not drift, the recording is malformed")
        }
    }
    err(String(format: "  durations: system %.3fs, mic %.3fs", systemDuration, micDuration))

    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = [
        "ffmpeg", "-y", "-v", "error",
        "-i", system.path,
        "-i", mic.path,
        // aformat downmixes whatever arrives; `pan=…c1` would fail outright on a mono
        // source, and a source can be mono: the file takes the shape of its first
        // buffer, and a device switch decides what that is.
        "-filter_complex",
        "[0:a]" + systemFilter + "[l];[1:a]" + micFilter + "[r];"
            + "[l][r]join=inputs=2:channel_layout=stereo[a]",
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

// MARK: - Self test

/// Connecting headphones switches the input device mid-meeting and the buffers change
/// shape. A real recording died exactly there, on the `mic` queue, inside
/// ExtAudioFile::WriteInputProc — an AudioToolbox assert, not a Swift error, so
/// `try?` was never going to save it.
///
/// Measured against a float32/48k/stereo file, writing a buffer of:
///   • Int16 **planar**  → aborts the process (this is the crash)
///   • Int16 interleaved, Int32, float mono, float interleaved → throws (buffer lost)
///   • float at 44.1 kHz, or float64 → *accepted*, written at the wrong rate/depth,
///     and nothing anywhere complains
///
/// So neither "it threw" nor "it returned" can be trusted. The writer converts every
/// buffer into the file's own processingFormat instead. Both traps are exercised.
func selfTest() -> Int32 {
    func float(rate: Double, frames: AVAudioFrameCount) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                   channels: 2, interleaved: false)!
        let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buf.frameLength = frames
        for ch in 0..<2 {
            for i in 0..<Int(frames) { buf.floatChannelData![ch][i] = sin(Float(i) * 0.05) * 0.5 }
        }
        return buf
    }
    /// Planar, not interleaved: interleaved Int16 merely throws, planar Int16 aborts.
    func int16Planar(rate: Double, frames: AVAudioFrameCount) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate,
                                   channels: 2, interleaved: false)!
        let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buf.frameLength = frames
        for ch in 0..<2 {
            for i in 0..<Int(frames) {
                buf.int16ChannelData![ch][i] = Int16(sin(Float(i) * 0.05) * 12000)
            }
        }
        return buf
    }

    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("summeet-selftest-\(UUID().uuidString).wav")
    defer { try? FileManager.default.removeItem(at: url) }

    let w = ChannelWriter(name: "selftest", url: url)
    w.append(float(rate: 48_000, frames: 4800))   // file opens: float32 48k stereo
    w.append(int16Planar(rate: 48_000, frames: 4800))  // headset: Int16 planar — aborts
    w.append(float(rate: 44_100, frames: 4410))   // and a different rate
    w.close()

    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        if !ok { failures += 1 }
        err("  \(ok ? "✓" : "✗") \(name)\(detail.isEmpty ? "" : "  \(detail)")")
    }

    // Reaching this line at all is the regression: the old writer aborted above.
    check("survived a mid-stream format change", true)
    check("converted both odd buffers", w.convertedBuffers == 2, "converted=\(w.convertedBuffers)")
    check("dropped nothing", w.droppedBuffers == 0, "dropped=\(w.droppedBuffers)")
    // The Int16 buffer must contribute energy, not read as silence: a "silent" mic
    // is exactly the failure the pipeline reports as a dead microphone.
    check("measured the Int16 buffer's energy", w.rms > 0.01, String(format: "rms=%.4f", w.rms))

    if let file = try? AVAudioFile(forReading: url) {
        // The resampler is primed on its first call and emits a short block. The
        // converter is cached, so that loss happens once at the switch, not per
        // buffer — otherwise the two channels would drift apart.
        check("wrote all three buffers", file.length > 12_000, "frames=\(file.length)")
        check("kept the file's original rate",
              file.processingFormat.sampleRate == 48_000, "\(file.processingFormat.sampleRate) Hz")
    } else {
        check("wrote a readable file", false)
    }

    err(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAILED (\(failures))")
    return failures == 0 ? 0 : 1
}

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
        if args.contains("--selftest") { exit(selfTest()) }

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
            // The microphone is captured separately, through CoreAudio.
            config.captureMicrophone = false
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

            guard let micCapture = MicCapture(writer: rec.mic) else {
                err("could not open the microphone through CoreAudio")
                exit(9)
            }
            err("microphone device: \(micCapture.deviceName)")

            try await stream.startCapture()
            micCapture.start()
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

            micCapture.stop()
            try await stream.stopCapture()
            try? await Task.sleep(nanoseconds: 300_000_000) // let writers flush
            rec.system.close()
            rec.mic.close()

            err(String(format: "  system: RMS %.6f peak %.4f (%d samples)",
                       rec.system.rms, rec.system.peak, rec.system.sampleCount))
            err(String(format: "  mic:    RMS %.6f peak %.4f (%d samples)",
                       rec.mic.rms, rec.mic.peak, rec.mic.sampleCount))
            err(String(format: "  raw peaks (before conversion): system %.4f  mic %.4f",
                       rec.system.rawPeak, rec.mic.rawPeak))

            // A device change mid-meeting (headphones in or out) is normal; losing
            // buffers to it is not. Say so rather than shipping a quiet gap.
            for (name, w) in [("system", rec.system), ("mic", rec.mic)] {
                if w.convertedBuffers > 0 || w.droppedBuffers > 0 {
                    err("  \(name): \(w.convertedBuffers) buffers converted, "
                        + "\(w.droppedBuffers) dropped (audio device changed mid-recording)")
                }
            }

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

            let micWall = (rec.mic.lastPTSEnd ?? 0) - (rec.mic.firstPTS ?? 0)
            try joinStereo(system: sysURL, mic: micURL, out: outURL,
                           systemStart: rec.system.firstPTS, micStart: rec.mic.firstPTS,
                           micWallSpan: micWall > 0 ? micWall : nil)
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

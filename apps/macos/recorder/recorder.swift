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
import CoreAudio
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// True when audio output is the **built-in speakers** — the one case where the microphone
/// picks up the meeting audio acoustically (echo / double-capture). Headphones (jack, USB,
/// Bluetooth) and anything we can't positively identify as the internal speaker return
/// false, so we never cry wolf. Read-only CoreAudio; it does not touch the capture path.
func outputIsBuiltInSpeaker() -> Bool {
    func fourCC(_ s: String) -> UInt32 {
        s.utf8.prefix(4).reduce(0) { ($0 << 8) | UInt32($1) }
    }
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr,
        device != 0 else { return false }

    // Only the built-in device can be the internal speaker; everything else is external.
    addr.mSelector = kAudioDevicePropertyTransportType
    var transport = UInt32(0)
    size = 4
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &transport) == noErr,
        transport == kAudioDeviceTransportTypeBuiltIn else { return false }

    // On the built-in device the output data source separates the speaker ('ispk') from the
    // headphone jack ('hdpn'). No source info → assume speaker (nothing plugged reported).
    addr.mSelector = kAudioDevicePropertyDataSource
    addr.mScope = kAudioObjectPropertyScopeOutput
    var source = UInt32(0)
    size = 4
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &source) == noErr else {
        return true
    }
    return source == fourCC("ispk")
}

// MARK: - Live chunks (streaming transcription)

/// Shorter than this, the last chunk is dropped rather than transcribed: there is nothing
/// useful in a second of trailing near-silence, and Whisper invents text when given one.
let MIN_TAIL_CHUNK_SEC = 2.0

/// One short slice of a source, cut while the recording is still running.
struct AudioChunk {
    let url: URL
    /// Where the chunk starts on the recording's own timeline, in seconds.
    let offsetSec: Double
    let durationSec: Double
    /// Where the *next* chunk takes over. The audio runs past this point (see ChunkTap)
    /// to give the last words their context; the server drops anything that starts after
    /// it, exactly as the offline chunker does with its overlap tail.
    let boundaryEndSec: Double
}

/// A rolling side-copy of everything a ChannelWriter writes, cut into short files so the
/// meeting can be transcribed *while* it happens instead of in one long pass at the end.
///
/// Deliberately additive: the main file still receives every buffer, byte for byte, so
/// nothing that goes wrong here can touch the authoritative full recording. The chunk is
/// written in the file's own format, which makes it an exact slice of what the recording
/// holds — and lets offsets be counted in frames rather than guessed from wall time.
///
/// Chunks **overlap**. A hard cut costs a word: measured on a synthetic call, every cut
/// swallowed the phrase straddling it ("Marker two" simply vanished). So at a cut the
/// finished chunk keeps recording for another `overlapSec` while the next one starts at
/// the cut itself — both files receive those seconds. The straddling words then land
/// whole, with their context, inside the earlier chunk, and the server discards whatever
/// starts past the boundary. This is the same trailing-overlap scheme `planChunks` /
/// `stitchSegments` use for oversized uploads (packages/core/src/audio).
final class ChunkTap {
    private struct OpenChunk {
        var file: AVAudioFile?
        let url: URL
        let startFrame: Int
        var frames: Int
        /// Frames at the cut. Nil while this is still the live chunk; set once it is only
        /// collecting the trailing overlap.
        var cutFrames: Int?
    }

    private let dir: URL
    private let name: String
    private let overlapSec: Double
    private var index = 0
    /// Frames written since chunking began — the recording's own timeline.
    private var total = 0
    private var sampleRate: Double = 0
    private var current: OpenChunk?
    /// Cut, but still collecting its overlap tail.
    private var closing: OpenChunk?
    private var ready: [AudioChunk] = []

    init(dir: URL, name: String, overlapSec: Double) {
        self.dir = dir
        self.name = name
        self.overlapSec = overlapSec
    }

    /// Seconds of audio in the chunk currently open. Chunk length is measured in captured
    /// audio, not wall time: if the source stalls, no chunk is emitted at all rather than
    /// a run of empty ones.
    var openSeconds: Double {
        guard sampleRate > 0, let current else { return 0 }
        return Double(current.frames) / sampleRate
    }

    var hasReady: Bool { !ready.isEmpty }

    /// Called from ChannelWriter.append, under its lock, with a buffer already converted
    /// to the file's format.
    func write(_ buf: AVAudioPCMBuffer) {
        if sampleRate == 0 { sampleRate = buf.format.sampleRate }
        if current == nil {
            index += 1
            let url = dir.appendingPathComponent("\(name)-chunk\(index).wav")
            let file = try? AVAudioFile(forWriting: url, settings: buf.format.settings,
                                        commonFormat: .pcmFormatFloat32,
                                        interleaved: buf.format.isInterleaved)
            if file != nil {
                current = OpenChunk(file: file, url: url, startFrame: total, frames: 0,
                                    cutFrames: nil)
            }
        }
        if var c = current {
            try? c.file?.write(from: buf)
            c.frames += Int(buf.frameLength)
            current = c
        }
        // The chunk past its cut keeps receiving the same buffers until it has its overlap.
        if var d = closing {
            try? d.file?.write(from: buf)
            d.frames += Int(buf.frameLength)
            if let cut = d.cutFrames, Double(d.frames - cut) >= overlapSec * sampleRate {
                closing = nil
                seal(d)
            } else {
                closing = d
            }
        }
        total += Int(buf.frameLength)
    }

    /// Mark the cut. The chunk isn't ready yet — it collects `overlapSec` more — while the
    /// next one starts here, so no audio falls between them. A cut is ignored while the
    /// previous one is still draining, which can only happen if asked twice in a few seconds.
    func cut() {
        guard closing == nil, var c = current, c.frames > 0 else { return }
        c.cutFrames = c.frames
        closing = c
        current = nil
    }

    /// Close everything still open (recording stopped). The last chunk has no successor, so
    /// nothing is dropped from its tail.
    func closeAll() {
        if let d = closing { closing = nil; seal(d) }
        guard var c = current else { return }
        current = nil
        // A sliver of a tail is not worth a transcription call, and Whisper hallucinates on
        // a second of near-silence (a 1.6 s tail came back as "Продолжение следует…").
        // The full recording still covers those seconds.
        if sampleRate > 0, Double(c.frames) / sampleRate < MIN_TAIL_CHUNK_SEC {
            c.file = nil
            try? FileManager.default.removeItem(at: c.url)
            return
        }
        seal(c)
    }

    func takeReady() -> AudioChunk? { ready.isEmpty ? nil : ready.removeFirst() }

    private func seal(_ chunk: OpenChunk) {
        var chunk = chunk
        chunk.file = nil // releasing closes the file and fixes up the WAV header
        guard chunk.frames > 0, sampleRate > 0 else {
            try? FileManager.default.removeItem(at: chunk.url)
            return
        }
        let boundary = chunk.cutFrames.map { Double(chunk.startFrame + $0) / sampleRate }
        ready.append(AudioChunk(url: chunk.url,
                                offsetSec: Double(chunk.startFrame) / sampleRate,
                                durationSec: Double(chunk.frames) / sampleRate,
                                boundaryEndSec: boundary ?? .infinity))
    }
}

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
    /// Samples that hit full scale — clipped, i.e. the mic's input gain is too high.
    private(set) var clippedSamples = 0
    var clippedFraction: Double { sampleCount > 0 ? Double(clippedSamples) / Double(sampleCount) : 0 }
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
    /// Energy and peak since the last takeLevel(), for the live meter.
    private var windowSumSquares: Double = 0
    private var windowCount = 0
    private var windowPeak: Float = 0
    /// Set only when live transcription is on: mirrors every written buffer into short
    /// chunk files. Nil = the recorder behaves exactly as it did before.
    private var tap: ChunkTap?
    private let lock = NSLock()

    init(name: String, url: URL) { self.name = name; self.url = url }

    /// Start mirroring into short chunk files (streaming transcription).
    func startChunking(dir: URL, overlapSec: Double) {
        lock.lock()
        defer { lock.unlock() }
        tap = ChunkTap(dir: dir, name: name, overlapSec: overlapSec)
    }

    /// Seconds of audio in the chunk currently open (0 when not chunking).
    var openChunkSeconds: Double {
        lock.lock()
        defer { lock.unlock() }
        return tap?.openSeconds ?? 0
    }

    /// End the current chunk here; the next one starts at this point.
    func cutChunk() {
        lock.lock()
        defer { lock.unlock() }
        tap?.cut()
    }

    /// Close every open chunk — recording has stopped.
    func closeChunks() {
        lock.lock()
        defer { lock.unlock() }
        tap?.closeAll()
    }

    /// A chunk whose audio (including its overlap tail) is complete, if one is waiting.
    var hasReadyChunk: Bool {
        lock.lock()
        defer { lock.unlock() }
        return tap?.hasReady ?? false
    }

    func takeReadyChunk() -> AudioChunk? {
        lock.lock()
        defer { lock.unlock() }
        return tap?.takeReady()
    }

    var rms: Double {
        sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0
    }
    var wroteAnything: Bool { sampleCount > 0 }

    /// RMS since the previous call, then reset. Recording blind is how every
    /// capture bug in this project survived to reach the user: report as we go.
    func takeLevel() -> (rms: Double, peak: Float) {
        lock.lock()
        defer { lock.unlock() }
        let level = windowCount > 0 ? (windowSumSquares / Double(windowCount)).squareRoot() : 0
        let p = windowPeak
        windowSumSquares = 0
        windowCount = 0
        windowPeak = 0
        return (level, p)
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
            var blockPeak: Float = 0
            for ch in 0..<Int(toWrite.format.channelCount) {
                let buf = data[ch]
                for i in 0..<Int(toWrite.frameLength) {
                    let v = abs(buf[i])
                    blockSumSquares += Double(v * v)
                    blockPeak = max(blockPeak, v)
                    // A sample at or past full scale is clipped: the true level was
                    // higher and got flattened. Counting them turns "peak 1.0" (which
                    // could be one loud word) into "how much of the take is distorted".
                    if v >= 0.999 { clippedSamples += 1 }
                }
            }
            let n = Int(toWrite.frameLength) * Int(toWrite.format.channelCount)
            sumSquares += blockSumSquares
            sampleCount += n
            peak = max(peak, blockPeak)
            windowSumSquares += blockSumSquares
            windowCount += n
            windowPeak = max(windowPeak, blockPeak)
        }

        try? file.write(from: toWrite)
        // The same buffer, into the chunk being streamed. After the main write, so the
        // recording is never behind the live copy.
        tap?.write(toWrite)
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
/// Every audio input the system can offer, so the user isn't stuck with whatever
/// happens to be the default. The default's own id is marked so the UI can preselect
/// it — the frequent trap is the output moving to the laptop while the input stays on
/// a headset that is no longer near the mouth.
func microphoneDevices() -> [(id: String, name: String, isDefault: Bool)] {
    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external],
        mediaType: .audio, position: .unspecified)
    let defaultID = AVCaptureDevice.default(for: .audio)?.uniqueID
    return session.devices.map {
        (id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultID)
    }
}

/// A microphone source that writes into a ChannelWriter. Two implementations: the plain
/// AVCaptureSession capture, and the echo-cancelled one (voice processing). The record
/// command picks one and can fall back from AEC to plain without losing the mic.
protocol MicSource: AnyObject {
    var deviceName: String { get }
    func start() throws
    func stop()
}

final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, MicSource {
    private let session = AVCaptureSession()
    private let writer: ChannelWriter
    let deviceName: String

    /// `deviceID` names a specific input (from microphoneDevices); nil takes the
    /// system default. An unknown or unavailable id falls back to the default rather
    /// than failing — a saved device that was later unplugged must not block a meeting.
    init?(writer: ChannelWriter, deviceID: String?) {
        let chosen = deviceID.flatMap { AVCaptureDevice(uniqueID: $0) }
            ?? AVCaptureDevice.default(for: .audio)
        guard let device = chosen,
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

/// Echo-cancelled microphone capture (the real fix for recording on speakers). Uses the
/// OS Voice-Processing I/O via AVAudioEngine, which removes the meeting audio the mic
/// picks up acoustically. AGC is turned off so the per-channel energy the diarizer
/// compares stays honest; noise suppression stays on. It captures the *default* input —
/// echo cancellation and arbitrary device selection don't mix cleanly, and the default
/// mic is the case that matters. Voice processing presents the processed mic on channel 0
/// (all channels carry the same mono signal), so we forward channel 0 as mono. Any failure
/// here is caught by the caller, which falls back to plain capture — the mic is never lost.
final class AECMicCapture: MicSource {
    private let engine = AVAudioEngine()
    private let writer: ChannelWriter
    let deviceName: String

    init?(writer: ChannelWriter) {
        self.writer = writer
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
        } catch {
            err("  [aec] setVoiceProcessingEnabled failed: \(error)")
            return nil
        }
        engine.inputNode.isVoiceProcessingAGCEnabled = false
        self.deviceName = "default input (echo-cancelled)"
    }

    func start() throws {
        let input = engine.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount >= 1,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: inFmt.sampleRate, channels: 1,
                                       interleaved: false) else {
            throw NSError(domain: "aec", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no usable input format"])
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { [weak self] buf, _ in
            guard let self, let src = buf.floatChannelData, buf.frameLength > 0,
                  let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength)
            else { return }
            out.frameLength = buf.frameLength
            memcpy(out.floatChannelData![0], src[0],
                   Int(buf.frameLength) * MemoryLayout<Float>.size)
            self.writer.append(out)
        }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
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
        // Opus, not WAV. A 48 kHz stereo WAV is 11.5 MB/min, so a 46-minute meeting —
        // an ordinary one — was rejected by the 500 MB upload cap. Opus at 64k stereo is
        // 25 MB/hour and, unlike FLAC, its size doesn't swing with the content (measured
        // 22-159 MB/hour for FLAC depending on the audio).
        //
        // The channels have to survive: diarization reads per-channel energy, and lossy
        // stereo coding can couple them. Measured against the uncompressed WAV on
        // simultaneously-active noise channels, Opus 64k gives identical attribution
        // (pnpm test:compression).
        "-map", "[a]", "-ar", "48000", "-c:a", "libopus", "-b:a", "64k", "-ac", "2",
        out.path,
    ]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
        throw NSError(domain: "ffmpeg", code: Int(p.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: "ffmpeg join failed"])
    }
}

// MARK: - Upload

/// Blocking request against the local API. The recorder is a short-lived CLI driven by
/// signals, not an event loop, so every call here is synchronous on purpose — but never
/// on the capture path (chunk uploads run on their own queue).
private func send(_ req: URLRequest, body: Data?, timeout: TimeInterval) throws -> Data {
    var req = req
    req.timeoutInterval = timeout
    var result: Result<Data, Error>!
    let done = DispatchSemaphore(value: 0)
    let handler: (Data?, URLResponse?, Error?) -> Void = { data, response, error in
        defer { done.signal() }
        if let error { result = .failure(error); return }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
            result = .failure(NSError(domain: "api", code: code,
                                      userInfo: [NSLocalizedDescriptionKey: "HTTP \(code): \(msg)"]))
            return
        }
        result = .success(data ?? Data())
    }
    if let body {
        URLSession.shared.uploadTask(with: req, from: body, completionHandler: handler).resume()
    } else {
        URLSession.shared.dataTask(with: req, completionHandler: handler).resume()
    }
    done.wait()
    return try result.get()
}

/// The meeting id out of a `{ "id": … }` response.
private func meetingId(from data: Data) throws -> String {
    guard let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])??["id"]
        as? String else {
        throw NSError(domain: "api", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "response had no meeting id"])
    }
    return id
}

/// A multipart POST carrying one audio file plus text fields.
private func postAudio(to url: URL, file: URL, filename: String, contentType: String,
                       fields: [(String, String)], timeout: TimeInterval) throws -> Data {
    let boundary = "summeet-\(UUID().uuidString)"
    var body = Data()
    for (name, value) in fields {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(value)\r\n".data(using: .utf8)!)
    }
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(filename)\"\r\n"
        .data(using: .utf8)!)
    body.append("Content-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
    body.append(try Data(contentsOf: file))
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return try send(req, body: body, timeout: timeout)
}

/// POSTs the recording to the local API, declaring the channel layout. Only our
/// recorders may declare it: the server refuses to infer speakers otherwise, so a
/// stranger's panned upload can never be attributed to "You".
func upload(file: URL, apiBase: String, title: String) throws -> String {
    let data = try postAudio(
        to: URL(string: "\(apiBase)/api/meetings")!,
        file: file, filename: "recording.ogg", contentType: "audio/ogg",
        fields: [("title", title), ("channelLayout", SUMMEET_STEREO_LAYOUT)],
        timeout: 300)
    return try meetingId(from: data)
}

/// Creates the meeting before there is any audio, so live chunks have something to
/// attach to. Called at the *first* chunk rather than at record time: a recording that
/// dies in its first seconds then leaves nothing behind.
func createMeeting(apiBase: String, title: String) throws -> String {
    var req = URLRequest(url: URL(string: "\(apiBase)/api/meetings/start")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body = try JSONSerialization.data(
        withJSONObject: ["title": title, "channelLayout": SUMMEET_STEREO_LAYOUT])
    return try meetingId(from: try send(req, body: body, timeout: 30))
}

/// One live chunk, at its position on the meeting timeline. The server queues it, so this
/// returns as soon as the bytes are in — it does not wait for the transcription.
/// `boundaryEndSec` is where the next chunk takes over: the audio deliberately runs past
/// it (overlap), and the server drops whatever starts after it. Omitted for the last chunk,
/// which has no successor.
func uploadSegment(file: URL, apiBase: String, meeting: String, offsetSec: Double,
                   boundaryEndSec: Double) throws {
    var fields = [("offsetSec", String(format: "%.3f", offsetSec))]
    if boundaryEndSec.isFinite {
        fields.append(("boundaryEndSec", String(format: "%.3f", boundaryEndSec)))
    }
    _ = try postAudio(
        to: URL(string: "\(apiBase)/api/meetings/\(meeting)/segment")!,
        file: file, filename: "segment.ogg", contentType: "audio/ogg",
        fields: fields, timeout: 120)
}

/// The full recording at stop. The server finalizes from the live transcript if it covers
/// this file, and otherwise transcribes it whole — so this upload is what makes streaming
/// safe to get wrong.
func finishMeeting(file: URL, apiBase: String, meeting: String) throws {
    _ = try postAudio(
        to: URL(string: "\(apiBase)/api/meetings/\(meeting)/finish")!,
        file: file, filename: "recording.ogg", contentType: "audio/ogg",
        fields: [], timeout: 300)
}

/// Removes a meeting that was created for live chunks but will never get its recording
/// (we refused to ship it). Best-effort: a leftover row is not worth failing over.
func discardMeeting(apiBase: String, meeting: String) {
    var req = URLRequest(url: URL(string: "\(apiBase)/api/meetings/\(meeting)?permanent=true")!)
    req.httpMethod = "DELETE"
    _ = try? send(req, body: nil, timeout: 30)
}

/// Kept in sync by hand with SUMMEET_STEREO_LAYOUT in packages/core/src/media.ts.
let SUMMEET_STEREO_LAYOUT = "summeet-stereo-v1"

// MARK: - Streaming transcription

/// Ships short chunks of the recording to the API while the meeting is still running, so
/// most of the transcript is already done by the time the user hits stop — instead of one
/// long pass at the end, which is what makes a local Whisper feel slow on a real meeting.
///
/// Everything here is best-effort by design. The full recording is still uploaded at stop
/// and the server only trusts the live transcript if it covers that recording, so a chunk
/// that fails, or a streamer that never starts, costs latency and nothing else.
final class SegmentStreamer {
    /// Never cut a chunk shorter than this: every cut risks splitting a word, and every
    /// chunk is one transcription call.
    private let minChunkSec: Double
    /// …and never let one run longer, however long the talking goes on.
    private let maxChunkSec: Double
    /// RMS under which a 200 ms window counts as a gap between words. Cutting there rather
    /// than mid-syllable is the cheapest protection a chunk boundary can get; when nobody
    /// pauses, maxChunkSec cuts anyway.
    private let silence = 0.003

    /// How far a chunk's audio runs past its cut, so the words straddling the cut are
    /// transcribed whole and in context. The server keeps only what starts before the cut.
    private let overlapSec: Double = 3

    private let apiBase: String
    private let title: String
    private let system: ChannelWriter
    private let mic: ChannelWriter
    private let dir: URL
    /// Serial: chunks reach the server in order, and one `sync` drains every pending
    /// upload before the finish call goes out.
    private let uploads = DispatchQueue(label: "summeet.segments")
    /// Owned by `uploads` — read elsewhere only after draining it.
    private var meeting: String?
    private var sentCount = 0
    private var failedCount = 0
    /// Whether any chunk was ever cut. A recording that stops before the first cut has
    /// nothing to gain from streaming — it takes the ordinary upload path instead of
    /// sending the same audio twice.
    private var didCut = false
    /// Set the moment finalizing starts, so a meter tick still in flight can't queue a
    /// chunk behind the drain and have it land after the meeting is finalized.
    private var stopped = false

    init(apiBase: String, title: String, system: ChannelWriter, mic: ChannelWriter, dir: URL,
         minChunkSec: Double = 45, maxChunkSec: Double = 75) {
        self.apiBase = apiBase
        self.title = title
        self.system = system
        self.mic = mic
        self.dir = dir
        self.minChunkSec = minChunkSec
        self.maxChunkSec = maxChunkSec
        system.startChunking(dir: dir, overlapSec: overlapSec)
        mic.startChunking(dir: dir, overlapSec: overlapSec)
    }

    /// Called from the meter loop with the levels it already measured. Chunk length is read
    /// off the audio itself, so a stalled source emits nothing rather than a run of empties.
    func tick(systemLevel: Double, micLevel: Double) {
        guard !stopped else { return }
        let open = system.openChunkSeconds
        if open >= maxChunkSec || (open >= minChunkSec && systemLevel < silence && micLevel < silence) {
            system.cutChunk()
            mic.cutChunk()
            didCut = true
        }
        drain()
    }

    /// Ship every chunk whose audio — overlap included — is complete. Both channels are cut
    /// at the same instants, so their queues advance together; anything else is a bug we
    /// would rather skip than upload as a misaligned stereo pair.
    private func drain() {
        while system.hasReadyChunk, mic.hasReadyChunk {
            guard let sys = system.takeReadyChunk(), let voice = mic.takeReadyChunk() else { return }
            uploads.async { [weak self] in self?.ship(sys, voice) }
        }
    }

    private func ship(_ sys: AudioChunk, _ voice: AudioChunk) {
        defer {
            try? FileManager.default.removeItem(at: sys.url)
            try? FileManager.default.removeItem(at: voice.url)
        }
        guard abs(sys.offsetSec - voice.offsetSec) < 1 else {
            failedCount += 1
            err(String(format: "live chunk skipped: channels are out of step (%.1fs vs %.1fs)",
                       sys.offsetSec, voice.offsetSec))
            return
        }
        let joined = dir.appendingPathComponent("segment-\(UUID().uuidString).ogg")
        defer { try? FileManager.default.removeItem(at: joined) }
        do {
            if meeting == nil {
                meeting = try createMeeting(apiBase: apiBase, title: title)
                // The shell reads this to know which meeting the recording became. With
                // streaming that is known now, not at the end.
                if let meeting { out("MEETING_ID=\(meeting)") }
            }
            guard let meeting else { return }
            try joinStereo(system: sys.url, mic: voice.url, out: joined,
                           systemStart: nil, micStart: nil, micWallSpan: nil)
            try uploadSegment(file: joined, apiBase: apiBase, meeting: meeting,
                              offsetSec: sys.offsetSec, boundaryEndSec: sys.boundaryEndSec)
            sentCount += 1
            err(String(format: "  live chunk %d: %.1fs at %.1fs sent (keeps up to %.1fs)",
                       sentCount, sys.durationSec, sys.offsetSec,
                       sys.boundaryEndSec.isFinite ? sys.boundaryEndSec
                           : sys.offsetSec + sys.durationSec))
        } catch {
            failedCount += 1
            err("live chunk at \(Int(sys.offsetSec))s failed: \(error.localizedDescription)")
        }
    }

    /// Ship what is still open and wait for every upload to land. The finish call must not
    /// overtake a chunk in flight: the server would append it to a meeting it had already
    /// finalized. Returns the meeting id, or nil if none was ever created (a recording too
    /// short to chunk, or a server that was not there).
    func finish() -> String? {
        stopped = true
        system.closeChunks()
        mic.closeChunks()
        // Stopped before the first cut: nothing was streamed and nothing is waiting on the
        // server. Throw the chunk away and let the caller upload the recording normally.
        guard didCut else {
            for writer in [system, mic] {
                while let leftover = writer.takeReadyChunk() {
                    try? FileManager.default.removeItem(at: leftover.url)
                }
            }
            return nil
        }
        drain()
        var id: String?
        uploads.sync { id = meeting }
        return id
    }

    /// Drop the meeting created for live chunks — we are refusing to ship its recording, and
    /// a half-transcribed row nobody asked for is worse than no row.
    func discard() {
        var id: String?
        uploads.sync { id = meeting }
        guard let id else { return }
        err("discarding live meeting \(id): the recording was refused")
        discardMeeting(apiBase: apiBase, meeting: id)
    }

    /// For the closing log line: how the live half actually went.
    var summary: String {
        var sent = 0
        var failed = 0
        uploads.sync { sent = sentCount; failed = failedCount }
        return "\(sent) chunk(s) sent" + (failed > 0 ? ", \(failed) failed" : "")
    }
}

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

/// Proves the streaming half from a terminal. The capture itself can't run headless —
/// ScreenCaptureKit needs a display and a signed bundle (§13.5) — but everything
/// downstream of it can: the chunk tap, the rotation, the per-chunk join, the three API
/// calls and their offsets. This feeds a real audio file through the very same writers the
/// capture feeds, with short chunks, and finishes the meeting for real.
///
///     recorder --streamtest sample.aiff --api http://localhost:8080 --title "…"
///                          [--chunk-min 45] [--chunk-max 75]
///
/// The chunk bounds default to the ones a real recording uses; shortening them is how a
/// one-minute sample can exercise several rotations, but note that short chunks give
/// Whisper less context and read worse — which is the point of measuring them.
///
/// The microphone side is not what's under test here, so it gets a faint hiss: the join
/// needs a second channel of the same length, and bit-exact silence is a case the recorder
/// deliberately refuses elsewhere.
func streamTest(input: URL, apiBase: String, title: String,
                minChunkSec: Double, maxChunkSec: Double) -> Int32 {
    let tmp = FileManager.default.temporaryDirectory
        .appendingPathComponent("summeet-streamtest-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmp) }

    let sysURL = tmp.appendingPathComponent("system.wav")
    let micURL = tmp.appendingPathComponent("mic.wav")
    let outURL = tmp.appendingPathComponent("recording.ogg")
    let rec = Recorder(systemURL: sysURL, micURL: micURL)
    let streamer = SegmentStreamer(apiBase: apiBase, title: title,
                                   system: rec.system, mic: rec.mic, dir: tmp,
                                   minChunkSec: minChunkSec, maxChunkSec: maxChunkSec)

    guard let file = try? AVAudioFile(forReading: input) else {
        err("streamtest: cannot read \(input.path)")
        return 1
    }
    let format = file.processingFormat
    let slice = AVAudioFrameCount(format.sampleRate * 0.5) // ~ a capture buffer's worth

    func hiss(like buf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: buf.format,
                                         frameCapacity: buf.frameLength),
              let d = out.floatChannelData else { return nil }
        out.frameLength = buf.frameLength
        let channels = buf.format.isInterleaved ? 1 : Int(buf.format.channelCount)
        let count = Int(buf.frameLength) * (buf.format.isInterleaved
            ? Int(buf.format.channelCount) : 1)
        for ch in 0..<channels {
            for i in 0..<count { d[ch][i] = Float.random(in: -0.002...0.002) }
        }
        return out
    }

    while true {
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: slice),
              (try? file.read(into: buf, frameCount: slice)) != nil,
              buf.frameLength > 0 else { break }
        rec.system.append(buf)
        if let quiet = hiss(like: buf) { rec.mic.append(quiet) }
        let sys = rec.system.takeLevel()
        let mic = rec.mic.takeLevel()
        streamer.tick(systemLevel: sys.rms, micLevel: mic.rms)
    }
    rec.system.close()
    rec.mic.close()

    do {
        try joinStereo(system: sysURL, mic: micURL, out: outURL,
                       systemStart: nil, micStart: nil, micWallSpan: nil)
        // Same decision the real recorder makes at stop.
        guard let id = streamer.finish() else {
            let id = try upload(file: outURL, apiBase: apiBase, title: title)
            out("MEETING_ID=\(id)")
            err("STREAMTEST PASS: too short to stream — uploaded whole, meeting \(id)")
            return 0
        }
        try finishMeeting(file: outURL, apiBase: apiBase, meeting: id)
        err("STREAMTEST PASS: \(streamer.summary), finished meeting \(id)")
        return 0
    } catch {
        err("STREAMTEST FAILED: \(error.localizedDescription)")
        return 1
    }
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

        // The shell asks for the device list before showing the picker. JSON on
        // stdout, one object, so it parses the same way as the other machine output.
        if args.contains("--list-mics") {
            let devices = microphoneDevices().map {
                ["id": $0.id, "name": $0.name, "default": $0.isDefault] as [String: Any]
            }
            if let data = try? JSONSerialization.data(withJSONObject: devices),
               let json = String(data: data, encoding: .utf8) {
                out(json)
            } else {
                out("[]")
            }
            exit(0)
        }

        let apiBase = take("--api")
        let title = take("--title") ?? "Meeting"
        let micDevice = take("--mic-device")
        var aec = false
        if let i = args.firstIndex(of: "--aec") {
            args.remove(at: i)
            aec = true
        }
        // Transcribe while recording instead of all at once at the end. Needs --api:
        // there is nothing to stream to otherwise.
        var live = false
        if let i = args.firstIndex(of: "--live") {
            args.remove(at: i)
            live = true
        }

        // Everything the streaming half does, minus the capture the terminal can't run.
        if let sample = take("--streamtest") {
            guard let apiBase else { err("--streamtest needs --api"); exit(64) }
            exit(streamTest(input: URL(fileURLWithPath: sample), apiBase: apiBase, title: title,
                            minChunkSec: take("--chunk-min").flatMap(Double.init) ?? 45,
                            maxChunkSec: take("--chunk-max").flatMap(Double.init) ?? 75))
        }

        guard let outPath = args.first else {
            err("usage: recorder <out.wav> [seconds] [--api URL] [--title T] "
                + "[--mic-device ID] [--aec] [--live]")
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

            // Pick the mic source. Echo cancellation applies only with the default mic
            // (device selection and voice processing don't mix cleanly); it can still fall
            // back to plain capture, so the mic is never lost.
            func openPlain() -> MicCapture {
                guard let m = MicCapture(writer: rec.mic, deviceID: micDevice) else {
                    err("could not open the microphone through CoreAudio")
                    exit(9)
                }
                return m
            }
            var micCapture: MicSource
            if aec, micDevice == nil, let aecMic = AECMicCapture(writer: rec.mic) {
                micCapture = aecMic
            } else {
                micCapture = openPlain()
            }
            err("microphone device: \(micCapture.deviceName)")

            try await stream.startCapture()
            do {
                try micCapture.start()
                if micCapture is AECMicCapture { err("microphone: echo cancellation ON") }
            } catch {
                // AEC failed to start: fall back to plain capture rather than lose the mic.
                err("echo cancellation failed to start (\(error)); using plain capture")
                micCapture.stop()
                let plain = openPlain()
                plain.start()
                micCapture = plain
            }
            err("recording… (system -> left, mic -> right)")

            // Transcribe while we record (streaming transcription). Started here, with the
            // capture, so chunk offsets are counted from the recording's own first frame.
            // Without --api there is nowhere to stream to.
            let streamer = live && apiBase != nil
                ? SegmentStreamer(apiBase: apiBase!, title: title,
                                  system: rec.system, mic: rec.mic, dir: tmp)
                : nil
            if streamer != nil { err("live transcription: on") }
            /// Refusing to ship the recording (below) must also take back the meeting the
            /// live chunks created, or the history keeps a row that never gets its audio.
            func giveUp(_ code: Int32) -> Never {
                streamer?.discard()
                exit(code)
            }

            // Live meter: the shell polls this to show the user, while recording,
            // that both sources are actually alive. Every capture failure in this
            // project was silent until the transcript came back wrong.
            let meter = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    let sys = rec.system.takeLevel()
                    let mic = rec.mic.takeLevel()
                    let spk = outputIsBuiltInSpeaker() ? 1 : 0
                    out(String(format: "LEVEL sys=%.5f mic=%.5f micpeak=%.5f spk=%d",
                               sys.rms, mic.rms, mic.peak, spk))
                    // The same levels decide where to cut the next live chunk: on a quiet
                    // window, so a boundary lands between words rather than inside one.
                    streamer?.tick(systemLevel: sys.rms, micLevel: mic.rms)
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
            meter.cancel() // no more chunk rotations while we close the files
            try? await Task.sleep(nanoseconds: 300_000_000) // let writers flush
            rec.system.close()
            rec.mic.close()

            err(String(format: "  system: RMS %.6f peak %.4f (%d samples)",
                       rec.system.rms, rec.system.peak, rec.system.sampleCount))
            err(String(format: "  mic:    RMS %.6f peak %.4f (%d samples)",
                       rec.mic.rms, rec.mic.peak, rec.mic.sampleCount))
            err(String(format: "  raw peaks (before conversion): system %.4f  mic %.4f",
                       rec.system.rawPeak, rec.mic.rawPeak))

            // Clipping ruins both transcription and speaker attribution: the flattened
            // peaks distort the per-channel energy the diarizer compares. The raw peak
            // exceeding 1.0 is the giveaway the OS gain is too high.
            if rec.mic.rawPeak > 1.0 || rec.mic.clippedFraction > 0.001 {
                err(String(format: """
                      MICROPHONE IS CLIPPING (raw peak %.3f, %.1f%% of samples at full scale).
                      The input gain is too high — lower it in System Settings → Sound → Input,
                      or move back from the mic. Clipping distorts who-said-what.
                    """, rec.mic.rawPeak, rec.mic.clippedFraction * 100))
            }

            // A device change mid-meeting (headphones in or out) is normal; losing
            // buffers to it is not. Say so rather than shipping a quiet gap.
            for (name, w) in [("system", rec.system), ("mic", rec.mic)] {
                if w.convertedBuffers > 0 || w.droppedBuffers > 0 {
                    err("  \(name): \(w.convertedBuffers) buffers converted, "
                        + "\(w.droppedBuffers) dropped (audio device changed mid-recording)")
                }
            }

            guard rec.system.wroteAnything || rec.mic.wroteAnything else {
                err("captured nothing"); giveUp(3)
            }
            // Without both sources there is no stereo layout to build, and the
            // pipeline would silently lose speaker attribution — fail loudly.
            guard rec.system.wroteAnything, rec.mic.wroteAnything else {
                err("only one source captured; refusing to write a misleading mono file")
                giveUp(4)
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
                giveUp(5)
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
                    giveUp(7)
                }
            }

            let micWall = (rec.mic.lastPTSEnd ?? 0) - (rec.mic.firstPTS ?? 0)
            try joinStereo(system: sysURL, mic: micURL, out: outURL,
                           systemStart: rec.system.firstPTS, micStart: rec.mic.firstPTS,
                           micWallSpan: micWall > 0 ? micWall : nil)
            out("OK \(outURL.path)")
            out("SYSTEM_RMS=\(rec.system.rms) MIC_RMS=\(rec.mic.rms)")

            if let apiBase {
                // Streamed: the meeting already exists and holds the live transcript, so the
                // recording goes to /finish — which uses it if it covers this file and
                // transcribes the file whole if it doesn't. `finish` also drains the chunks
                // still in flight, so none can land after the meeting is finalized.
                if let streamer, let id = streamer.finish() {
                    err("uploading the full recording to \(apiBase) (live: \(streamer.summary))…")
                    try finishMeeting(file: outURL, apiBase: apiBase, meeting: id)
                } else {
                    err("uploading to \(apiBase)…")
                    let id = try upload(file: outURL, apiBase: apiBase, title: title)
                    out("MEETING_ID=\(id)")
                }
                try? FileManager.default.removeItem(at: outURL) // the server owns it now
            }
            exit(0)
        } catch {
            err("ERROR: \(error.localizedDescription)")
            exit(1)
        }
    }
}

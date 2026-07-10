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
    private let lock = NSLock()

    init(url: URL) { self.url = url }

    var rms: Double {
        sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0
    }
    var wroteAnything: Bool { sampleCount > 0 }

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
            for ch in 0..<Int(format.channelCount) {
                let buf = data[ch]
                for i in 0..<Int(frames) {
                    let v = buf[i]
                    sumSquares += Double(v * v)
                    peak = max(peak, abs(v))
                }
            }
            sampleCount += Int(frames) * Int(format.channelCount)
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

func err(_ s: String) { FileHandle.standardError.write("\(s)\n".data(using: .utf8)!) }

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
        defer { try? FileManager.default.removeItem(at: tmp) }

        guard #available(macOS 15.0, *) else {
            err("needs macOS 15+ (SCStream microphone capture)")
            exit(1)
        }

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
                print("MIC_SILENT=1")
                exit(5)
            }

            try joinStereo(system: sysURL, mic: micURL, out: outURL)
            print("OK \(outURL.path)")
            print("SYSTEM_RMS=\(rec.system.rms) MIC_RMS=\(rec.mic.rms)")

            if let apiBase {
                err("uploading to \(apiBase)…")
                let id = try upload(file: outURL, apiBase: apiBase, title: title)
                print("MEETING_ID=\(id)")
                try? FileManager.default.removeItem(at: outURL) // the server owns it now
            }
            exit(0)
        } catch {
            err("ERROR: \(error.localizedDescription)")
            exit(1)
        }
    }
}

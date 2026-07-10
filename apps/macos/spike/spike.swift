// Spike (SPEC §13.5): can we capture SYSTEM audio on macOS with ScreenCaptureKit,
// with no virtual audio driver (no BlackHole)? If yes, the native app can record
// Meet/Zoom/Teams — browser or desktop — without an extension.
//
// Records N seconds of system audio to a WAV and prints the RMS so we can tell
// real audio from silence.
//
//   swiftc -O spike.swift -o spike -framework ScreenCaptureKit -framework AVFoundation
//   ./spike out.wav 5

import AVFoundation
import CoreMedia
import ScreenCaptureKit

final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var audioFile: AVAudioFile?
    private let outURL: URL
    private(set) var sampleCount = 0
    private(set) var sumSquares: Double = 0
    private(set) var peak: Float = 0

    init(outURL: URL) {
        self.outURL = outURL
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)?.pointee,
              let format = AVAudioFormat(streamDescription: [asbd]) else { return }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        pcm.frameLength = frames

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
        guard status == noErr else { return }

        // Measure loudness so "it ran" can't be confused with "it captured".
        if let data = pcm.floatChannelData {
            let channels = Int(format.channelCount)
            for ch in 0..<channels {
                let buf = data[ch]
                for i in 0..<Int(frames) {
                    let v = buf[i]
                    sumSquares += Double(v * v)
                    peak = max(peak, abs(v))
                }
            }
            sampleCount += Int(frames) * channels
        }

        if audioFile == nil {
            audioFile = try? AVAudioFile(forWriting: outURL,
                                         settings: format.settings,
                                         commonFormat: .pcmFormatFloat32,
                                         interleaved: format.isInterleaved)
            FileHandle.standardError.write(
                "  format: \(Int(format.sampleRate))Hz, \(format.channelCount)ch\n".data(using: .utf8)!)
        }
        try? audioFile?.write(from: pcm)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("  stream stopped: \(error)\n".data(using: .utf8)!)
    }

    var rms: Double { sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0 }
}

@main
struct Spike {
    static func main() async {
        let args = CommandLine.arguments
        let outPath = args.count > 1 ? args[1] : "out.wav"
        let seconds = args.count > 2 ? Double(args[2]) ?? 5 : 5

        do {
            // Throws if Screen Recording permission hasn't been granted.
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                print("NO_DISPLAY"); exit(2)
            }

            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            // We only want audio; keep the video plane as small as allowed.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let capture = SystemAudioCapture(outURL: URL(fileURLWithPath: outPath))
            let stream = SCStream(filter: filter, configuration: config, delegate: capture)
            try stream.addStreamOutput(capture, type: .audio,
                                       sampleHandlerQueue: DispatchQueue(label: "audio"))
            try await stream.startCapture()
            FileHandle.standardError.write("  capturing \(seconds)s of system audio…\n".data(using: .utf8)!)

            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            try await stream.stopCapture()

            // Give the writer a moment to flush.
            try await Task.sleep(nanoseconds: 200_000_000)

            print("RMS=\(String(format: "%.6f", capture.rms)) PEAK=\(String(format: "%.4f", capture.peak)) SAMPLES=\(capture.sampleCount)")
            exit(capture.sampleCount > 0 ? 0 : 3)
        } catch {
            print("ERROR: \(error.localizedDescription)")
            exit(1)
        }
    }
}

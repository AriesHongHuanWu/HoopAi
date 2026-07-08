import ExpoModulesCore
import AVFoundation
import CoreMedia

/// A stitch segment in SECONDS of source time. Clamped to the asset duration
/// natively; the TS layer sanitizes first, but native never trusts its input.
struct StitchSegment: Record {
  @Field var startSec: Double = 0
  @Field var endSec: Double = 0
}

struct StitchOptions: Record {
  @Field var sourceUri: String = ""
  @Field var segments: [StitchSegment] = []
  /// Optional output basename (no extension needed). Defaults to a timestamped name.
  @Field var outputFileName: String? = nil
}

/// Coded errors surfaced to JS as `error.code`. Every failure path rejects the
/// promise with one of these — the module must never crash the app.
private enum StitchError: String {
  case noSource = "ERR_NO_SOURCE"
  case badAsset = "ERR_BAD_ASSET"
  case noSegments = "ERR_NO_SEGMENTS"
  case noVideoTrack = "ERR_NO_VIDEO_TRACK"
  case composition = "ERR_COMPOSITION"
  case exportSetup = "ERR_EXPORT_SETUP"
  case exportFailed = "ERR_EXPORT_FAILED"
  case cancelled = "ERR_CANCELLED"
  case output = "ERR_OUTPUT"
}

public class VideoStitcherModule: Module {
  /// The in-flight export, retained so `cancel()` can reach it and so it is not
  /// deallocated mid-export. Touched only on the module (background) queue.
  private var activeExport: AVAssetExportSession?
  /// Guards against concurrent stitches (one export at a time keeps memory sane).
  private var isStitching = false

  public func definition() -> ModuleDefinition {
    Name("VideoStitcher")

    // Emitted once per segment as it is appended to the composition. Payload:
    // { index, total }. Progress is coarse (per-segment) but enough for a
    // "cutting clip 3 of 8" style indicator; the actual export is fast.
    Events("onProgress")

    /// Cheap availability probe. The module existing at all means the native
    /// side linked, so this is always true here — the TS guard handles the
    /// "module missing" (Expo Go / old build) case by returning false.
    Function("isAvailable") { () -> Bool in
      return true
    }

    /// Best-effort cancel of an in-flight export. Safe to call anytime.
    Function("cancel") { [weak self] () -> Void in
      self?.activeExport?.cancelExport()
    }

    AsyncFunction("stitch") { (options: StitchOptions, promise: Promise) in
      self.performStitch(options: options, promise: promise)
    }
  }

  // MARK: - Implementation

  private func performStitch(options: StitchOptions, promise: Promise) {
    if isStitching {
      promise.reject(StitchError.composition.rawValue, "A stitch is already in progress.")
      return
    }

    guard let sourceURL = Self.resolveURL(options.sourceUri) else {
      promise.reject(StitchError.noSource.rawValue, "sourceUri is empty or invalid.")
      return
    }

    if options.segments.isEmpty {
      promise.reject(StitchError.noSegments.rawValue, "No segments to stitch.")
      return
    }

    let asset = AVURLAsset(url: sourceURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    isStitching = true

    // Load duration + tracks asynchronously (synchronous access is deprecated on
    // iOS 16+, which is our deployment target). Everything after runs on the
    // module queue via the AsyncFunction executor already.
    asset.loadValuesAsynchronously(forKeys: ["duration", "tracks"]) { [weak self] in
      guard let self = self else { return }
      var durErr: NSError?
      let durStatus = asset.statusOfValue(forKey: "duration", error: &durErr)
      let trackStatus = asset.statusOfValue(forKey: "tracks", error: &durErr)
      if durStatus != .loaded || trackStatus != .loaded {
        self.finish { self.isStitching = false }
        promise.reject(StitchError.badAsset.rawValue,
                       "Could not read the source video: \(durErr?.localizedDescription ?? "unknown").")
        return
      }
      self.buildAndExport(asset: asset, options: options, promise: promise)
    }
  }

  private func buildAndExport(asset: AVURLAsset, options: StitchOptions, promise: Promise) {
    let assetDuration = asset.duration
    let assetSeconds = CMTimeGetSeconds(assetDuration)

    let composition = AVMutableComposition()
    guard
      let compVideoTrack = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else {
      finish { self.isStitching = false }
      promise.reject(StitchError.composition.rawValue, "Could not create a video track.")
      return
    }
    // Audio is optional — a silent clip is still a valid reel.
    let compAudioTrack = composition.addMutableTrack(
      withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

    guard let srcVideoTrack = asset.tracks(withMediaType: .video).first else {
      finish { self.isStitching = false }
      promise.reject(StitchError.noVideoTrack.rawValue, "The source has no video track.")
      return
    }
    let srcAudioTrack = asset.tracks(withMediaType: .audio).first

    // Preserve orientation (portrait phone recordings carry a transform).
    compVideoTrack.preferredTransform = srcVideoTrack.preferredTransform

    let timescale = assetDuration.timescale != 0 ? assetDuration.timescale : 600
    var cursor = CMTime.zero
    var appended = 0
    let total = options.segments.count

    for (i, seg) in options.segments.enumerated() {
      // Clamp the requested window to [0, assetSeconds]; skip degenerate ones.
      let startS = max(0.0, min(seg.startSec, assetSeconds))
      let endS = max(0.0, min(seg.endSec, assetSeconds))
      if endS - startS <= 0.02 { continue }

      let start = CMTime(seconds: startS, preferredTimescale: timescale)
      let dur = CMTime(seconds: endS - startS, preferredTimescale: timescale)
      let range = CMTimeRange(start: start, duration: dur)

      do {
        try compVideoTrack.insertTimeRange(range, of: srcVideoTrack, at: cursor)
        if let compAudioTrack = compAudioTrack, let srcAudioTrack = srcAudioTrack {
          // Audio insert failure is non-fatal — keep the video, drop the sound.
          try? compAudioTrack.insertTimeRange(range, of: srcAudioTrack, at: cursor)
        }
        cursor = CMTimeAdd(cursor, dur)
        appended += 1
        self.sendEvent("onProgress", ["index": i, "total": total])
      } catch {
        // One bad range shouldn't kill the whole reel; skip and continue.
        continue
      }
    }

    if appended == 0 {
      finish { self.isStitching = false }
      promise.reject(StitchError.noSegments.rawValue,
                     "None of the segments fell inside the video.")
      return
    }

    export(composition: composition, options: options, promise: promise)
  }

  private func export(composition: AVMutableComposition, options: StitchOptions, promise: Promise) {
    // Passthrough is the fast path: no re-encode, seconds not minutes. Fall back
    // to HighestQuality only if the composition can't be exported losslessly.
    let preset = composition.canExportPassthrough
      ? AVAssetExportPresetPassthrough
      : AVAssetExportPresetHighestQuality

    guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
      finish { self.isStitching = false }
      promise.reject(StitchError.exportSetup.rawValue, "Could not create an export session.")
      return
    }

    let outputURL: URL
    do {
      outputURL = try Self.makeOutputURL(fileName: options.outputFileName)
    } catch {
      finish { self.isStitching = false }
      promise.reject(StitchError.output.rawValue, "Could not prepare the output file.")
      return
    }

    session.outputURL = outputURL
    session.outputFileType = .mp4
    session.shouldOptimizeForNetworkUse = true
    activeExport = session

    session.exportAsynchronously { [weak self] in
      guard let self = self else { return }
      let status = session.status
      self.activeExport = nil
      self.isStitching = false

      switch status {
      case .completed:
        let durationSec = CMTimeGetSeconds(composition.duration)
        promise.resolve([
          "uri": outputURL.absoluteString,
          "durationSec": durationSec.isFinite ? durationSec : 0,
        ])
      case .cancelled:
        try? FileManager.default.removeItem(at: outputURL)
        promise.reject(StitchError.cancelled.rawValue, "Export was cancelled.")
      default:
        try? FileManager.default.removeItem(at: outputURL)
        let msg = session.error?.localizedDescription ?? "unknown export failure"
        promise.reject(StitchError.exportFailed.rawValue, "Export failed: \(msg)")
      }
    }
  }

  // MARK: - Helpers

  /// Run a cleanup closure. Extracted so the reject paths read cleanly.
  private func finish(_ cleanup: () -> Void) { cleanup() }

  /// Accepts `file://…`, plain absolute paths, and other URL schemes.
  private static func resolveURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    if let url = URL(string: trimmed), url.scheme != nil { return url }
    return URL(fileURLWithPath: trimmed)
  }

  /// A writable output path in the caches directory. Reels are ephemeral
  /// artifacts (the user shares them out), so caches — not documents — is right.
  private static func makeOutputURL(fileName: String?) throws -> URL {
    let dir = try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("reels", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    var base = (fileName?.isEmpty == false)
      ? fileName!
      : "reel-\(Int(Date().timeIntervalSince1970 * 1000))"
    if base.lowercased().hasSuffix(".mp4") { base = String(base.dropLast(4)) }
    // Strip path separators so a caller-supplied name can't escape the dir.
    base = base.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-")

    let url = dir.appendingPathComponent("\(base).mp4")
    // AVAssetExportSession refuses to overwrite; clear any stale file first.
    try? FileManager.default.removeItem(at: url)
    return url
  }
}

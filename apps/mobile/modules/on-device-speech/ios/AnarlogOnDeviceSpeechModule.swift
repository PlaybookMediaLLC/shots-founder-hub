import AVFoundation
import ExpoModulesCore
import Speech

// Transcribes saved recordings with Apple's on-device engines only. When neither
// engine can run on the device for a locale, the capability is "none"; this
// module never falls back to a network recognizer. It never logs transcript text.
public class AnarlogOnDeviceSpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AnarlogOnDeviceSpeech")

    AsyncFunction("getCapability") { (locale: String) async -> [String: String] in
      let engine = await OnDeviceSpeech.engine(for: OnDeviceSpeech.requestedLocale(locale))
      return ["engine": engine.rawValue, "permission": OnDeviceSpeech.permission()]
    }

    AsyncFunction("requestPermission") { () async -> String in
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        SFSpeechRecognizer.requestAuthorization { _ in continuation.resume() }
      }
      return OnDeviceSpeech.permission()
    }

    AsyncFunction("transcribeFile") {
      (path: String, locale: String, contextualStrings: [String]) async throws -> [String: Any] in
      try await OnDeviceSpeech.transcribe(
        url: OnDeviceSpeech.fileURL(path),
        locale: OnDeviceSpeech.requestedLocale(locale),
        contextualStrings: contextualStrings
      )
    }
  }
}

private struct Segment {
  var startMs: Int
  var endMs: Int
  var text: String
  var approximate = false

  var dictionary: [String: Any] {
    var value: [String: Any] = ["startMs": startMs, "endMs": endMs, "text": text]
    if approximate { value["approximate"] = true }
    return value
  }
}

private enum Engine: String {
  case speechAnalyzer = "speech_analyzer"
  case sfSpeechOnDevice = "sf_speech_on_device"
  case none
}

private func failure(_ description: String, code: String) -> Exception {
  Exception(name: "OnDeviceSpeechError", description: description, code: code)
}

private func milliseconds(_ seconds: Double) -> Int {
  seconds.isFinite ? Int((seconds * 1000).rounded()) : 0
}

private enum OnDeviceSpeech {
  // The pre-iOS 26 recognizer is restarted about once a minute; words at each
  // restart can be lost, so those segments are marked approximate.
  static let fallbackChunkSeconds = 60.0

  static func permission() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "denied"
    }
  }

  static func fileURL(_ path: String) -> URL {
    if let url = URL(string: path), url.isFileURL { return url }
    return URL(fileURLWithPath: path)
  }

  // A bare language ("en") takes the device region, so English on a UK phone
  // resolves to en-GB rather than whichever English the engine lists first.
  static func requestedLocale(_ identifier: String) -> Locale {
    let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return Locale.current }
    let locale = Locale(identifier: trimmed)
    if locale.region == nil, let region = Locale.current.region {
      return Locale(identifier: "\(trimmed)-\(region.identifier)")
    }
    return locale
  }

  static func engine(for locale: Locale) async -> Engine {
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      let supported = await supportedTranscriberLocale(locale)
      if supported != nil { return .speechAnalyzer }
    }
    return onDeviceRecognizer(for: locale) == nil ? .none : .sfSpeechOnDevice
  }

  static func transcribe(url: URL, locale: Locale, contextualStrings: [String]) async throws
    -> [String: Any]
  {
    // One speech-recognition consent covers both engines, so a denial always
    // leaves an audio-only note.
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
      throw failure("Speech recognition permission is not granted.", code: "ERR_PERMISSION")
    }
    var engine = Engine.none
    var resolved = locale
    var segments: [Segment] = []
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable,
      let supported = await supportedTranscriberLocale(locale)
    {
      engine = .speechAnalyzer
      resolved = supported
      segments = try await transcribeWithSpeechAnalyzer(
        url: url, locale: supported, contextualStrings: contextualStrings)
    } else if let recognizer = onDeviceRecognizer(for: locale) {
      engine = .sfSpeechOnDevice
      resolved = recognizer.locale
      segments = try await transcribeWithRecognizer(
        url: url, recognizer: recognizer, contextualStrings: contextualStrings)
    } else {
      throw failure(
        "This device cannot transcribe \(locale.identifier(.bcp47)) on device.",
        code: "ERR_UNSUPPORTED_LOCALE")
    }
    return [
      "text": segments.map(\.text).joined(separator: " "),
      "engine": engine.rawValue,
      "locale": resolved.identifier(.bcp47),
      "segments": segments.map(\.dictionary),
    ]
  }

  // MARK: iOS 26 long-form engine (mirrors crates/transcribe-speechanalyzer on macOS)

  // `supportedLocale(equivalentTo:)` can echo unknown tags back, so its answer is
  // only trusted after checking it against `supportedLocales`.
  @available(iOS 26.0, *)
  static func supportedTranscriberLocale(_ requested: Locale) async -> Locale? {
    guard let candidate = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      return nil
    }
    let tag = candidate.identifier(.bcp47).lowercased()
    let supported = await SpeechTranscriber.supportedLocales
    return supported.contains { $0.identifier(.bcp47).lowercased() == tag } ? candidate : nil
  }

  // Downloading the locale's model is an Apple asset download; audio stays on the device.
  @available(iOS 26.0, *)
  static func installAssets(for transcriber: SpeechTranscriber, locale: Locale) async throws {
    let tag = locale.identifier(.bcp47)
    let reserved = await AssetInventory.reservedLocales
    if !reserved.contains(where: { $0.identifier(.bcp47) == tag }) {
      if reserved.count >= AssetInventory.maximumReservedLocales,
        let evictable = reserved.first(where: { $0.identifier(.bcp47) != tag })
      {
        _ = await AssetInventory.release(reservedLocale: evictable)
      }
      _ = try await AssetInventory.reserve(locale: locale)
    }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    // downloadAndInstall() can return after only queueing the first attempt.
    for _ in 0..<120 {
      switch await AssetInventory.status(forModules: [transcriber]) {
      case .installed:
        return
      case .unsupported:
        throw failure(
          "This device cannot transcribe \(tag) on device.", code: "ERR_UNSUPPORTED_LOCALE")
      default:
        try await Task.sleep(nanoseconds: 500_000_000)
      }
    }
    throw failure("The speech model for \(tag) is not installed yet.", code: "ERR_ASSETS_NOT_READY")
  }

  // unverified: AnalysisContext.contextualStrings with the .general tag and
  // SpeechAnalyzer.setContext(_:) on iOS 26; confirm SpeechTranscriber applies the terms.
  @available(iOS 26.0, *)
  static func applyContextualStrings(_ strings: [String], to analyzer: SpeechAnalyzer)
    async throws
  {
    guard !strings.isEmpty else { return }
    var context = AnalysisContext()
    context.contextualStrings[.general] = strings
    try await analyzer.setContext(context)
  }

  @available(iOS 26.0, *)
  static func transcribeWithSpeechAnalyzer(url: URL, locale: Locale, contextualStrings: [String])
    async throws -> [Segment]
  {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange]
    )
    try await installAssets(for: transcriber, locale: locale)
    let file = try AVAudioFile(forReading: url)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await applyContextualStrings(contextualStrings, to: analyzer)
    let collector = Task<[Segment], Error> {
      var segments: [Segment] = []
      for try await result in transcriber.results where result.isFinal {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }
        segments.append(
          Segment(
            startMs: milliseconds(result.range.start.seconds),
            endMs: milliseconds((result.range.start + result.range.duration).seconds),
            text: text))
      }
      return segments
    }
    do {
      _ = try await analyzer.analyzeSequence(from: file)
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      collector.cancel()
      throw error
    }
    return try await collector.value
  }

  // MARK: Pre-iOS 26 fallback: SFSpeechRecognizer, on-device only

  static func onDeviceRecognizer(for requested: Locale) -> SFSpeechRecognizer? {
    let tag = requested.identifier(.bcp47).lowercased()
    let language = requested.language.languageCode
    let supported = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }
    let match =
      supported.first { $0.identifier(.bcp47).lowercased() == tag }
      ?? supported.first {
        $0.language.languageCode == language && $0.region == Locale.current.region
      }
      ?? supported.first { $0.language.languageCode == language }
    guard let match, let recognizer = SFSpeechRecognizer(locale: match),
      recognizer.supportsOnDeviceRecognition
    else { return nil }
    return recognizer
  }

  // unverified: on-device recognition of a 60 s appended buffer returns every word
  // (no server-style one-minute cut-off) and a 30-minute file finishes in reasonable time.
  static func transcribeWithRecognizer(
    url: URL, recognizer: SFSpeechRecognizer, contextualStrings: [String]
  ) async throws -> [Segment] {
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    let chunkFrames = AVAudioFrameCount(format.sampleRate * fallbackChunkSeconds)
    let chunked = file.length > AVAudioFramePosition(chunkFrames)
    var segments: [Segment] = []
    while file.framePosition < file.length {
      let offsetMs = milliseconds(Double(file.framePosition) / format.sampleRate)
      guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else {
        throw failure("Could not read the recording.", code: "ERR_AUDIO")
      }
      try file.read(into: buffer, frameCount: chunkFrames)
      if buffer.frameLength == 0 { break }

      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = false
      request.addsPunctuation = true
      request.contextualStrings = contextualStrings
      request.append(buffer)
      request.endAudio()

      guard let transcription = try await recognize(request, with: recognizer) else { continue }
      let text = transcription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      let first = transcription.segments.first
      let last = transcription.segments.last
      segments.append(
        Segment(
          startMs: offsetMs + milliseconds(first?.timestamp ?? 0),
          endMs: offsetMs
            + milliseconds(
              last.map { $0.timestamp + $0.duration }
                ?? Double(buffer.frameLength) / format.sampleRate),
          text: text,
          approximate: chunked))
    }
    return segments
  }

  // Resolves nil for a chunk with no speech.
  static func recognize(_ request: SFSpeechRecognitionRequest, with recognizer: SFSpeechRecognizer)
    async throws -> SFTranscription?
  {
    var task: SFSpeechRecognitionTask?
    let transcription: SFTranscription? = try await withCheckedThrowingContinuation {
      continuation in
      var resumed = false
      task = recognizer.recognitionTask(with: request) { result, error in
        guard !resumed else { return }
        if let result, result.isFinal {
          resumed = true
          continuation.resume(returning: result.bestTranscription)
        } else if let error {
          resumed = true
          // unverified: kAFAssistantErrorDomain 1110 means "no speech detected" on device.
          let nsError = error as NSError
          if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 {
            continuation.resume(returning: nil)
          } else {
            continuation.resume(throwing: error)
          }
        }
      }
    }
    withExtendedLifetime(task) {}
    return transcription
  }
}

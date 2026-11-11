# On-device speech

iOS-only Expo module that transcribes a saved recording on the device. iOS 26 and later use `SpeechAnalyzer` with `SpeechTranscriber`; earlier versions, and locales `SpeechTranscriber` does not support, use `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. When neither can run for the locale the capability is `none`: the module never uses a network recognizer. It does not log transcript text.

`src/data/on-device-transcription.ts` is the only caller. It persists the result as a `batch_transcription` transcript (provider `apple_speech`), or returns `null` for no engine, no permission or no speech.

## Device checks

Nothing here has run on a device yet. Each `// unverified:` comment in `ios/AnarlogOnDeviceSpeechModule.swift` names an API to confirm. Check:

1. **Permission denied.** Deny speech recognition when prompted, or turn it off in Settings. Recording still saves and plays; `transcribeSessionOnDevice` returns `null` and writes no transcript. The prompt text says recognition happens on the device.
2. **Unsupported locale → null.** Set the app language to one neither engine supports on the device (for example Norwegian on iOS 26). `getCapability` returns `engine: "none"`, and the note keeps no transcript. With the device offline and the Apple provider selected, nothing reaches a network recognizer.
3. **iOS 26 path.** On iOS 26 with English: the first run downloads the locale's speech model (an Apple asset download), then `engine` is `speech_analyzer` and the transcript row's model is `apple-speech-analyzer`. Confirm segment times match the audio and that vocabulary terms (`AnalysisContext` contextual strings) are recognized. Offline on first use should fail with `ERR_ASSETS_NOT_READY`, not hang.
4. **Fallback path.** On iOS 18 or earlier, or a locale only `SFSpeechRecognizer` supports on device: `engine` is `sf_speech_on_device`, the model is `apple-sf-speech-on-device`, and a recording over 60 seconds has segments marked `approximate`. Check words at each 60-second boundary, and that a silent chunk returns no text instead of an error (`kAFAssistantErrorDomain` 1110).
5. **A 30-minute file.** Transcribe a 30-minute recording on both paths with the app in the foreground. Note the time taken and memory use, and what happens when the app goes to the background mid-transcription. Calling the function again while one is running for the same note must not start a second recognition.

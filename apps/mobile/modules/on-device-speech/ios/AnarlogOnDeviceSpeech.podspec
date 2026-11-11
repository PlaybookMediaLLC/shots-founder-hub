Pod::Spec.new do |s|
  s.name           = 'AnarlogOnDeviceSpeech'
  s.version        = '1.0.0'
  s.summary        = 'Transcribes saved Anarlog recordings on the device.'
  s.description    = 'Uses SpeechAnalyzer on iOS 26 and on-device SFSpeechRecognizer before it; never a network recognizer.'
  s.author         = 'Anarlog'
  s.homepage       = 'https://anarlog.so'
  s.platform       = :ios, '16.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Speech'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

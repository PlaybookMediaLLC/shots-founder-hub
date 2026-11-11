import { NativeModule, requireOptionalNativeModule } from "expo";

type Permission = "granted" | "denied" | "restricted" | "undetermined";

declare class AnarlogOnDeviceSpeechModule extends NativeModule {
  getCapability(locale: string): Promise<{
    engine: "speech_analyzer" | "sf_speech_on_device" | "none";
    permission: Permission;
  }>;
  requestPermission(): Promise<Permission>;
  transcribeFile(
    path: string,
    locale: string,
    contextualStrings: string[],
  ): Promise<{
    text: string;
    engine: "speech_analyzer" | "sf_speech_on_device";
    locale: string;
    segments: {
      startMs: number;
      endMs: number;
      text: string;
      approximate?: boolean;
    }[];
  }>;
}

// Null off iOS: Android and web have no on-device engine here.
export default requireOptionalNativeModule<AnarlogOnDeviceSpeechModule>(
  "AnarlogOnDeviceSpeech",
);

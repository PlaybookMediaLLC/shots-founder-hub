// Apple on-device transcription for recordings sent to Shots (Shots voice
// capture plan, decision 10: on-device by default). The Shots sync calls this
// before sending a note; it writes a canonical batch_transcription transcript
// exactly like transcribe.ts does and returns it, or null when the device or
// locale has no on-device engine (the note then syncs without a transcript).

export type OnDeviceSegment = {
  startMs: number;
  endMs: number;
  text: string;
  /** True at a recognizer restart boundary, where words may be missing. */
  approximate?: boolean;
};

export type OnDeviceTranscript = {
  transcriptId: string;
  text: string;
  /** For example "apple-speech-analyzer" or "apple-sf-speech-on-device". */
  engine: string;
  locale: string;
  segments: OnDeviceSegment[];
};

export async function transcribeSessionOnDevice(
  sessionId: string,
  options: { locale?: string; vocabulary?: string[] } = {},
): Promise<OnDeviceTranscript | null> {
  void sessionId;
  void options;
  throw new Error("On-device transcription is not implemented yet.");
}

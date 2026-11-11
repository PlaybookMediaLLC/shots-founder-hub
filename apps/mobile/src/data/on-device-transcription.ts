// Apple on-device transcription for recordings sent to Shots (Shots voice
// capture plan, decision 10: on-device by default). The Shots sync calls this
// before sending a note; it writes a canonical batch_transcription transcript
// exactly like transcribe.ts does and returns it, or null when the device or
// locale has no on-device engine (the note then syncs without a transcript).
import { File, Paths } from "expo-file-system";

import { execute, executeTransaction } from "@/db";
import { id, nowIso } from "@/lib/ids";
import { readPreferences } from "@/settings/preferences";

import OnDeviceSpeech from "../../modules/on-device-speech";
import { generateSummaryAfterTranscription } from "./summarize";
import { pendingSummaryStatement } from "./summary-job";
import { batchTranscriptStatements } from "./transcript-model";

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

const ENGINE_LABELS = {
  speech_analyzer: "apple-speech-analyzer",
  sf_speech_on_device: "apple-sf-speech-on-device",
} as const;

const SESSION_AUDIO_SQL = `
SELECT
  local_state.relative_path AS local_relative_path,
  COALESCE(json_extract(attachment.metadata_json, '$.capture_started_at_ms'),
    (SELECT MIN(started_at_ms) FROM transcripts WHERE audio_attachment_id = attachment.id),
    CAST((julianday(attachment.created_at) - 2440587.5) * 86400000 AS INTEGER)) AS capture_started_at_ms
FROM session_attachments AS attachment
JOIN attachment_local_state AS local_state
  ON local_state.attachment_id = attachment.id
 AND local_state.availability = 'present'
WHERE attachment.session_id = ?
  AND attachment.source_type = 'session_audio'
  AND attachment.deleted_at IS NULL
LIMIT 1
`;

const inflight = new Map<string, Promise<OnDeviceTranscript | null>>();

/**
 * Transcribes the session's local recording on this device and replaces the
 * session's transcripts with the result (desktop batch semantics), whatever
 * transcript the session had before. Resolves null, writing nothing, when the
 * locale has no on-device engine, speech permission is not granted, or no
 * speech was recognized. Audio never leaves the device; like every completed
 * transcription, the app's automatic summary then runs with the user's
 * summary provider.
 */
export function transcribeSessionOnDevice(
  sessionId: string,
  options: { locale?: string; vocabulary?: string[] } = {},
): Promise<OnDeviceTranscript | null> {
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const task = run(sessionId, options).finally(() =>
    inflight.delete(sessionId),
  );
  inflight.set(sessionId, task);
  return task;
}

async function run(
  sessionId: string,
  options: { locale?: string; vocabulary?: string[] },
): Promise<OnDeviceTranscript | null> {
  if (!OnDeviceSpeech) return null;
  const [audio] = await execute<{
    local_relative_path: string;
    capture_started_at_ms: number | null;
  }>(SESSION_AUDIO_SQL, [sessionId]);
  const file = audio
    ? new File(Paths.document, "sessions", sessionId, audio.local_relative_path)
    : null;
  if (!audio || !file?.exists)
    throw Object.assign(
      new Error("This note has no recording on this device."),
      {
        code: "audio_missing",
      },
    );

  const preferences = await readPreferences();
  const locale = options.locale ?? preferences.ai_language;
  const capability = await OnDeviceSpeech.getCapability(locale);
  if (capability.engine === "none") return null;
  const permission =
    capability.permission === "undetermined"
      ? await OnDeviceSpeech.requestPermission()
      : capability.permission;
  if (permission !== "granted") return null;

  const result = await OnDeviceSpeech.transcribeFile(
    file.uri,
    locale,
    options.vocabulary ?? preferences.personalization_dictionary_terms,
  );
  const segments = result.segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) return [];
    const startMs = Math.max(0, Math.round(segment.startMs));
    return [
      {
        startMs,
        endMs: Math.max(startMs, Math.round(segment.endMs)),
        text,
        ...(segment.approximate ? { approximate: true } : {}),
      },
    ];
  });
  if (!segments.length) return null;

  // The engines time phrases, not words: spread each phrase's words evenly
  // across its span, like desktop's synthetic_text fallback.
  const words = segments.flatMap(({ startMs, endMs, text }) => {
    const tokens = text.split(/\s+/);
    const span = endMs - startMs;
    return tokens.map((token, index) => ({
      id: id(),
      text: token,
      start_ms: startMs + Math.round((span * index) / tokens.length),
      end_ms: startMs + Math.round((span * (index + 1)) / tokens.length),
      channel: 0,
    }));
  });
  const transcriptId = id();
  const engine = ENGINE_LABELS[result.engine];
  const [, inserted] = await executeTransaction([
    ...batchTranscriptStatements(
      sessionId,
      {
        id: transcriptId,
        provider: "apple_speech",
        model: engine,
        language: result.locale,
        startedAtMs: audio.capture_started_at_ms ?? Date.now(),
        wordsJson: JSON.stringify(words),
        hintsJson: "[]",
      },
      nowIso(),
    ),
    pendingSummaryStatement(sessionId),
  ]);
  // The note was deleted while it was being transcribed.
  if (inserted !== 1) return null;
  generateSummaryAfterTranscription(sessionId);
  return {
    transcriptId,
    text: result.text.trim() || segments.map(({ text }) => text).join(" "),
    engine,
    locale: result.locale,
    segments,
  };
}

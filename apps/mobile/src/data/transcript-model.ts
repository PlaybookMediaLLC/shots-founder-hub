export const SESSION_TRANSCRIPTS_SQL = `SELECT transcript.id, transcript.source, transcript.provider, transcript.started_at_ms, transcript.owner_user_id, transcript.words_json, transcript.speaker_hints_json,
      (SELECT json_extract(session.metadata_json, '$.speaker_context') FROM sessions AS session WHERE session.id = transcript.session_id) AS speaker_context_json,
      COALESCE((SELECT json_group_array(json(ordered_delta.delta_json)) FROM (
        SELECT delta.delta_json FROM transcript_live_deltas AS delta
        WHERE delta.transcript_id = transcript.id ORDER BY delta.sequence
      ) AS ordered_delta), '[]') AS pending_deltas_json
      FROM transcripts AS transcript WHERE transcript.session_id = ? AND transcript.deleted_at IS NULL
      ORDER BY transcript.started_at_ms, transcript.created_at, transcript.id`;

export const SESSION_SPEAKERS_SQL = `SELECT id, name FROM humans WHERE workspace_id = (SELECT workspace_id FROM sessions WHERE id = ?) AND name <> ''`;

export const SESSION_HAS_TRANSCRIPT_SQL = `SELECT EXISTS (
  SELECT 1 FROM transcripts WHERE session_id = ? AND deleted_at IS NULL
) AS has_transcript`;

export type TranscriptRow = {
  id: string;
  source?: string;
  provider?: string;
  started_at_ms: number;
  owner_user_id: string;
  speaker_context_json: string | null;
  words_json: string;
  speaker_hints_json: string;
  pending_deltas_json: string;
};

export type TranscriptSegment = {
  id: string;
  text: string;
  speaker: string;
  startMs: number;
  wordCount: number;
};

// Desktop's createTranscript for batch results: whole-session replace with
// source batch_transcription, then mark the primary session audio transcribed.
export function batchTranscriptStatements(
  sessionId: string,
  transcript: {
    id: string;
    provider: string;
    model: string;
    language: string;
    startedAtMs: number;
    wordsJson: string;
    hintsJson: string;
  },
  now: string,
) {
  return [
    {
      sql: `UPDATE transcripts
SET deleted_at = ?, updated_at = ?
WHERE session_id = ? AND deleted_at IS NULL`,
      params: [now, now, sessionId] as unknown[],
    },
    {
      sql: `INSERT INTO transcripts (
  id, workspace_id, owner_user_id, session_id, source, provider,
  model, language, started_at_ms, ended_at_ms, audio_attachment_id,
  memo, words_json, speaker_hints_json, metadata_json, created_at,
  updated_at, deleted_at
)
SELECT ?, session.workspace_id, session.owner_user_id, session.id,
  'batch_transcription', ?, ?, ?, ?, NULL, '',
  COALESCE((
    SELECT note.body FROM session_documents AS note
    WHERE note.id = session.id AND note.kind = 'note' AND note.deleted_at IS NULL
  ), ''),
  ?, ?, '{}', ?, ?, NULL
FROM sessions AS session
WHERE session.id = ? AND session.deleted_at IS NULL`,
      params: [
        transcript.id,
        transcript.provider,
        transcript.model,
        transcript.language,
        transcript.startedAtMs,
        transcript.wordsJson,
        transcript.hintsJson,
        now,
        now,
        sessionId,
      ] as unknown[],
    },
    {
      sql: `UPDATE session_attachments
SET
  metadata_json = json_set(
    CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
    '$.transcript_status',
    'complete'
  ),
  updated_at = ?
WHERE id = ? AND session_id = ? AND source_type = 'session_audio'
  AND source_id = 'primary' AND deleted_at IS NULL`,
      params: [now, `session-audio:${sessionId}`, sessionId] as unknown[],
    },
  ];
}

export function sharedMicrophoneContextStatement(
  sessionId: string,
  startedAtMs: number,
  durationMs: number,
  updatedAt: string,
) {
  return {
    sql: `UPDATE sessions SET metadata_json = json_set(
      metadata_json, '$.speaker_context', json_insert(
        COALESCE(json_extract(metadata_json, '$.speaker_context'), '{"intervals":[]}'),
        '$.intervals[#]', json(?)
      )
    ), updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    params: [
      JSON.stringify({
        start_ms: startedAtMs,
        end_ms: startedAtMs + Math.max(1, Math.ceil(durationMs)),
        active_call: false,
        calendar_call: false,
        mic_isolated: null,
        shared_microphone: true,
        title: "",
        self_names: [],
        participants: [],
      }),
      updatedAt,
      sessionId,
    ],
  };
}

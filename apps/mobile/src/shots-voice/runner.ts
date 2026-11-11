import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";

import { supabase } from "@/auth/client";
import { ACCOUNT_SESSION_SQL } from "@/data/account-sessions";
import { deviceTimeZone } from "@/data/audio-catalog";
import { transcribeSessionOnDevice } from "@/data/on-device-transcription";
import { isTranscriptionRunning } from "@/data/transcribe";
import {
  SESSION_HAS_TRANSCRIPT_SQL,
  SESSION_SPEAKERS_SQL,
  SESSION_TRANSCRIPTS_SQL,
  type TranscriptRow,
} from "@/data/transcript-model";
import { mapTranscripts } from "@/data/transcripts";
import { execute } from "@/db";
import { env } from "@/lib/env";
import { captureOperationalError } from "@/lib/error-reporting";
import { readPreferences } from "@/settings/preferences";

import { voiceFetch } from "./api";
import {
  runVoicePass,
  type VoiceEngineDeps,
  type VoiceRequest,
} from "./engine";
import {
  newVoiceNote,
  nextPassDelayMs,
  parseVoiceCommand,
  parseVoiceSettings,
  voiceErrorMessage,
  type VoiceCommand,
} from "./model";
import {
  getShotsVoice,
  removeShotsVoiceNote,
  saveShotsVoiceNote,
  setShotsVoiceStatus,
  whenShotsVoiceReady,
} from "./store";

// Wires the sync engine to this app: the Shots session, local SQLite reads,
// the recording file and on-device transcription. Recording and local saves
// never wait on any of it.

/** A voice API call as the signed-in account; a different or missing session answers 401. */
export async function shotsVoiceRequest(
  accountId: string,
  workspaceId: string,
  request: VoiceRequest,
) {
  const session = supabase
    ? (await supabase.auth.getSession()).data.session
    : null;
  if (!session || session.user.id !== accountId)
    return { status: 401, body: null };
  return voiceFetch({
    apiUrl: env.apiUrl,
    accessToken: session.access_token,
    workspaceId,
    request,
  });
}

async function readVoice<T>(
  accountId: string,
  workspaceId: string,
  request: VoiceRequest,
  parse: (body: unknown) => T | null,
): Promise<T> {
  const response = await shotsVoiceRequest(accountId, workspaceId, request);
  const parsed =
    response.status >= 200 && response.status < 300
      ? parse(response.body)
      : null;
  if (parsed) return parsed;
  throw new Error(
    voiceErrorMessage(response.body) ??
      (response.status === 401
        ? "Sign in again to use Shots."
        : "Shots could not be reached. Try again."),
  );
}

export const readShotsVoiceSettings = (
  accountId: string,
  workspaceId: string,
) =>
  readVoice(
    accountId,
    workspaceId,
    { method: "GET", suffix: "settings" },
    parseVoiceSettings,
  );

export const updateShotsVoiceMember = (
  accountId: string,
  workspaceId: string,
  body: { remoteTextConsent?: boolean; voiceCommands?: boolean },
) =>
  readVoice(
    accountId,
    workspaceId,
    { method: "PUT", suffix: "settings/member", body },
    parseVoiceSettings,
  );

/** Confirms a proposal once; Shots replays a repeated confirm (K11). */
export async function confirmShotsVoiceCommand(
  sessionId: string,
  body: {
    text: string;
    channelConnectionId: string;
    localTime: string;
    timeZone: string;
  },
): Promise<VoiceCommand> {
  const { accountId, prefs, notes } = getShotsVoice();
  const remoteId = notes.find((note) => note.sessionId === sessionId)?.remoteId;
  if (!accountId || !prefs.workspaceId || !remoteId)
    throw new Error("This note is not in Shots yet.");
  const workspaceId = prefs.workspaceId;
  try {
    const command = await readVoice(
      accountId,
      workspaceId,
      { method: "POST", suffix: `notes/${remoteId}/command/confirm`, body },
      (value) =>
        parseVoiceCommand((value as { command?: unknown } | null)?.command),
    );
    const latest = getShotsVoice().notes.find(
      (note) => note.sessionId === sessionId,
    );
    if (latest)
      await saveShotsVoiceNote(accountId, workspaceId, { ...latest, command });
    return command;
  } catch (error) {
    // Expired, withdrawn or re-parsed: the next pass brings the card up to date.
    requestShotsVoiceSync();
    throw error;
  }
}

/**
 * Queues a saved recording for Shots: always for an explicit "Send to Shots",
 * otherwise only when "Send new recordings to Shots" is on.
 */
export async function queueSessionForShots(
  sessionId: string,
  options: { explicit: boolean; durationMs?: number },
): Promise<
  "queued" | "off" | "no_workspace" | "deleted_in_shots" | "other_account"
> {
  await whenShotsVoiceReady();
  const { accountId, prefs, notes } = getShotsVoice();
  if (!env.shotsUrl || !accountId || !prefs.workspaceId) return "no_workspace";
  if (!options.explicit && !prefs.sendNew) return "off";
  const existing = notes.find((note) => note.sessionId === sessionId);
  // S7: a note deleted in Shots is never recreated.
  if (existing?.deletedRemote) return "deleted_in_shots";
  if (existing) {
    if (options.explicit && (existing.failed || existing.blocked))
      await saveShotsVoiceNote(accountId, prefs.workspaceId, {
        ...existing,
        failed: null,
        blocked: null,
        attempts: 0,
        nextAttemptAt: 0,
      });
    requestShotsVoiceSync();
    return "queued";
  }
  const [session] = await execute<{
    created_at: string;
    started_ms: number | null;
    time_zone: unknown;
    owned: number;
  }>(
    `SELECT session.created_at,
      json_extract(session.metadata_json, '$.mobile_capture_started_at_ms') AS started_ms,
      json_extract(session.metadata_json, '$.mobile_capture_time_zone') AS time_zone,
      ${ACCOUNT_SESSION_SQL} AS owned
    FROM sessions AS session WHERE session.id = ? AND session.deleted_at IS NULL`,
    [accountId, accountId, sessionId],
  );
  if (!session) return "off";
  // Another account's recording on this phone is never sent under this account.
  if (!session.owned) return "other_account";
  const preferences = await readPreferences();
  await saveShotsVoiceNote(
    accountId,
    prefs.workspaceId,
    newVoiceNote({
      sessionId,
      recordedAt:
        typeof session.started_ms === "number"
          ? new Date(session.started_ms).toISOString()
          : session.created_at,
      // The phone's zone at recording time resolves "tomorrow at 10" (K1, K3, K24).
      recordedTimeZone:
        typeof session.time_zone === "string" && session.time_zone
          ? session.time_zone
          : deviceTimeZone(),
      locale: preferences.ai_language || null,
      durationMs:
        options.durationMs && options.durationMs > 0
          ? Math.round(options.durationMs)
          : null,
      audioUploadConsent: prefs.uploadAudio,
    }),
  );
  requestShotsVoiceSync();
  return "queued";
}

/** Recorder hook: never throws into the recording save path. */
export function queueRecordingForShots(sessionId: string, durationMs: number) {
  void queueSessionForShots(sessionId, { explicit: false, durationMs }).catch(
    (error) => {
      captureOperationalError(error, {
        operation: "shots_voice_queue",
        level: "warning",
      });
    },
  );
}

const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;

const TRANSCRIPT_VERSIONS_SQL = `
SELECT transcript.id, transcript.content_version, transcript.provider, transcript.model
FROM transcripts AS transcript
WHERE transcript.session_id = ?1 AND transcript.deleted_at IS NULL
  AND (?2 = 1 OR NOT EXISTS (
    SELECT 1 FROM session_attachments AS attachment
    WHERE attachment.id = 'session-audio:' || ?1 AND attachment.deleted_at IS NULL
      AND COALESCE(json_extract(attachment.metadata_json, '$.transcript_status'), '') <> 'complete'
  ))
ORDER BY transcript.started_at_ms, transcript.created_at, transcript.id
`;

function engineDeps(
  accountId: string,
  workspaceId: string,
  uploadAudio: boolean,
): VoiceEngineDeps {
  const active = () => {
    const current = getShotsVoice();
    return (
      current.accountId === accountId &&
      current.prefs.workspaceId === workspaceId
    );
  };
  return {
    accountId,
    workspaceId,
    isActive: active,
    request: (target, request) => shotsVoiceRequest(accountId, target, request),
    put: async (sessionId, audio, upload) =>
      (
        await new File(
          Paths.document,
          "sessions",
          sessionId,
          audio.relativePath,
        ).upload(upload.url, {
          httpMethod: "PUT",
          headers: upload.headers,
          sessionType: "foreground",
        })
      ).status,
    audio: async (sessionId) => {
      const [row] = await execute<{
        content_type: string;
        size_bytes: number;
        sha256: string;
        relative_path: string;
      }>(
        `SELECT attachment.content_type, attachment.size_bytes, attachment.sha256, local.relative_path
        FROM session_attachments AS attachment
        JOIN attachment_local_state AS local
          ON local.attachment_id = attachment.id AND local.availability = 'present'
        WHERE attachment.id = ? AND attachment.source_type = 'session_audio'
          AND attachment.deleted_at IS NULL`,
        [`session-audio:${sessionId}`],
      );
      return row &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        row.size_bytes > 0 &&
        row.relative_path
        ? {
            contentType: row.content_type,
            bytes: Number(row.size_bytes),
            sha256: row.sha256,
            relativePath: row.relative_path,
          }
        : null;
    },
    transcriptionRunning: isTranscriptionRunning,
    transcribe: async (sessionId) => {
      // Rows of an unfinished transcription are the user's too; never replace them.
      const [row] = await execute<{ has_transcript: number }>(
        SESSION_HAS_TRANSCRIPT_SQL,
        [sessionId],
      );
      if (row?.has_transcript) return null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      // A stuck engine must not hold every later note; the engine retries it.
      return Promise.race([
        transcribeSessionOnDevice(sessionId),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("On-device transcription timed out.")),
            TRANSCRIBE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
    },
    transcriptVersion: async (sessionId, ids) => {
      const rows = (
        await execute<{
          id: string;
          content_version: string;
          provider: string;
          model: string;
        }>(TRANSCRIPT_VERSIONS_SQL, [sessionId, ids ? 1 : 0])
      ).filter((row) => !ids || ids.includes(row.id));
      if (rows.length === 0 || (ids && rows.length !== ids.length)) return null;
      return {
        source: rows[0]!.provider === "apple_speech" ? "on_device" : "provider",
        sourceIds: rows.map((row) => row.id),
        versionKey: rows
          .map((row) => `${row.id}:${row.content_version}`)
          .join(","),
        engine:
          [rows[0]!.provider, rows[0]!.model]
            .filter(Boolean)
            .join("/")
            .slice(0, 64) || null,
      };
    },
    transcriptText: async (sessionId, ids) => {
      const rows = (
        await execute<TranscriptRow>(SESSION_TRANSCRIPTS_SQL, [sessionId])
      ).filter((row) => ids.includes(row.id));
      const humans = await execute<{ id: string; name: string }>(
        SESSION_SPEAKERS_SQL,
        [sessionId],
      );
      return mapTranscripts(rows, humans)
        .map((segment) => segment.text)
        .join("\n");
    },
    deletedSessions: async (sessionIds) =>
      new Set(
        sessionIds.length === 0
          ? []
          : (
              await execute<{ id: string }>(
                "SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))",
                [JSON.stringify(sessionIds)],
              )
            ).map((row) => row.id),
      ),
    notes: () => (active() ? getShotsVoice().notes : []),
    save: (note) => saveShotsVoiceNote(accountId, workspaceId, note),
    remove: (sessionId) =>
      removeShotsVoiceNote(accountId, workspaceId, sessionId),
    report: (error) =>
      captureOperationalError(error, {
        operation: "shots_voice_note",
        level: "warning",
      }),
    appVersion: Constants.expoConfig?.version ?? "0.0.0",
    uploadAudio,
    now: Date.now,
  };
}

let running = false;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let offlinePasses = 0;

/** Runs a pass for the active account and workspace now, or after the current one. */
export function requestShotsVoiceSync(): void {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  void runPass().finally(() => {
    running = false;
    if (rerun) {
      rerun = false;
      requestShotsVoiceSync();
    }
  });
}

export function stopShotsVoiceSync(): void {
  clearTimeout(timer);
  timer = undefined;
}

async function runPass() {
  await whenShotsVoiceReady();
  const { accountId, prefs } = getShotsVoice();
  if (!env.shotsUrl || !accountId || !prefs.workspaceId) return;
  const workspaceId = prefs.workspaceId;
  stopShotsVoiceSync();
  let result;
  try {
    result = await runVoicePass(
      engineDeps(accountId, workspaceId, prefs.uploadAudio),
    );
  } catch (error) {
    captureOperationalError(error, {
      operation: "shots_voice_sync",
      level: "warning",
    });
    result = {
      status: "offline" as const,
      message: "Sending to Shots failed. It will be tried again.",
      nextAttemptAt: Date.now() + 60_000,
    };
  }
  setShotsVoiceStatus(accountId, workspaceId, result);
  offlinePasses = result.status === "offline" ? offlinePasses + 1 : 0;
  if (result.nextAttemptAt !== null)
    timer = setTimeout(
      requestShotsVoiceSync,
      nextPassDelayMs(
        result.nextAttemptAt - Date.now(),
        offlinePasses,
        Math.random(),
      ),
    );
}

/** The Shots workspaces this account can read, from the gateway's projection of the Shots session. */
export async function fetchShotsWorkspaces(
  accessToken: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  if (!supabase) return [];
  const result = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("kind", "shared")
    .is("deleted_at", null)
    .order("name")
    .setHeader("Authorization", `Bearer ${accessToken}`)
    .abortSignal(signal);
  if (result.error) throw result.error;
  return (Array.isArray(result.data) ? result.data : []).filter(
    (workspace): workspace is { id: string; name: string } =>
      typeof workspace.id === "string" && typeof workspace.name === "string",
  );
}

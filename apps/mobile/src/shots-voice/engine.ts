import {
  BLOCKED_RETRY_MS,
  MAX_AUDIO_FAILURES,
  MAX_ON_DEVICE_FAILURES,
  classifyVoiceStatus,
  diffVoiceIndex,
  isAppVersionSupported,
  isVoiceNoteUnsent,
  nextVoiceOp,
  parseVoiceIndex,
  parseVoiceNoteDetail,
  parseVoiceSettings,
  parseVoiceUpload,
  retryDelayMs,
  transcriptRevisionFor,
  voiceErrorMessage,
  type VoiceNoteState,
  type VoiceOp,
  type VoiceOutcome,
  type VoiceSegment,
  type VoiceSettings,
} from "./model.ts";

// One sync pass for one account's queue in one Shots workspace (plan 5.2 "Sync"):
// read settings, push each note's pending work idempotently, then compare the
// note index and pull what changed. Every effect goes through `deps`.

export type VoiceRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  suffix: string;
  body?: unknown;
};

export type VoiceAudioInfo = {
  contentType: string;
  bytes: number;
  sha256: string;
  relativePath: string;
};

export type VoiceEngineDeps = {
  accountId: string;
  workspaceId: string;
  /** False once another account signs in or another workspace is chosen. */
  isActive: (accountId: string, workspaceId: string) => boolean;
  /** Throws on a network failure. */
  request: (
    workspaceId: string,
    request: VoiceRequest,
  ) => Promise<{ status: number; body: unknown }>;
  /** PUTs the run to the signed URL; returns the status, throws on a network failure. */
  put: (
    sessionId: string,
    audio: VoiceAudioInfo,
    upload: NonNullable<VoiceNoteState["upload"]>,
  ) => Promise<number>;
  audio: (sessionId: string) => Promise<VoiceAudioInfo | null>;
  /** True while the user's own transcription of the session is queued or running. */
  transcriptionRunning: (sessionId: string) => boolean;
  /** On-device transcript, null when the device has no engine; throws on failure. */
  transcribe: (sessionId: string) => Promise<{
    transcriptId: string;
    text: string;
    engine: string;
    locale: string;
    segments: VoiceSegment[];
  } | null>;
  /** The local transcript rows' version, all rows of the session or only `ids`. */
  transcriptVersion: (
    sessionId: string,
    ids?: string[],
  ) => Promise<{
    source: "on_device" | "provider";
    sourceIds: string[];
    versionKey: string;
    engine: string | null;
  } | null>;
  transcriptText: (sessionId: string, ids: string[]) => Promise<string>;
  deletedSessions: (sessionIds: string[]) => Promise<Set<string>>;
  notes: () => VoiceNoteState[];
  save: (note: VoiceNoteState) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  /** Reports a note that failed in an unexpected way; the pass goes on. */
  report: (error: unknown) => void;
  appVersion: string;
  uploadAudio: boolean;
  now: () => number;
};

export type VoicePassStatus =
  | "idle"
  | "offline"
  | "signed_out"
  | "blocked"
  | "update_required"
  | "disabled"
  | "inactive";

export type VoicePassResult = {
  status: VoicePassStatus;
  message: string | null;
  nextAttemptAt: number | null;
};

export const NO_ACCESS_MESSAGE =
  "Shots refused these notes: you may no longer be in this workspace, or voice notes are off there. Your notes stay on this phone.";
const SIGNED_OUT: VoicePassResult = {
  status: "signed_out",
  message:
    "Sign in again as this account to send notes to Shots. Your notes stay on this phone.",
  nextAttemptAt: null,
};
const MAX_STEPS_PER_NOTE = 8;
// The gateway's body limit for voice requests.
const MAX_VOICE_BODY_BYTES = 1024 * 1024;
const characters = (text: string) => [...text].length;
// Shots refuses a NUL anywhere in the text it stores.
const withoutNul = (text: string) => text.replaceAll("\0", "");
// Shots' 409s all carry the code "conflict"; this sentence marks a deleted note.
const NOTE_DELETED = "This voice note was deleted.";
const EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

class Stop {
  readonly result: VoicePassResult;
  constructor(result: VoicePassResult) {
    this.result = result;
  }
}

type Reply = { kind: VoiceOutcome; body: unknown; message: string | null };

export async function runVoicePass(
  deps: VoiceEngineDeps,
): Promise<VoicePassResult> {
  const now = deps.now();
  // Sign-out or a workspace switch ends the pass before its next step.
  const stopIfInactive = () => {
    if (!deps.isActive(deps.accountId, deps.workspaceId))
      throw new Stop({
        status: "inactive",
        message: null,
        nextAttemptAt: null,
      });
  };
  const call = async (request: VoiceRequest): Promise<Reply> => {
    stopIfInactive();
    try {
      const response = await deps.request(deps.workspaceId, request);
      return {
        kind: classifyVoiceStatus(response.status),
        body: response.body,
        message: voiceErrorMessage(response.body),
      };
    } catch {
      return {
        kind: "retry",
        body: null,
        message: "Shots could not be reached.",
      };
    }
  };
  const save = async (note: VoiceNoteState) => {
    await deps.save(note);
    return note;
  };

  // A failed request: stop the pass on systemic failures, park the note otherwise.
  const failed = async (note: VoiceNoteState, reply: Reply) => {
    if (reply.kind === "signed_out") throw new Stop(SIGNED_OUT);
    if (reply.kind === "blocked")
      return save({
        ...note,
        blocked: reply.message ?? NO_ACCESS_MESSAGE,
        nextAttemptAt: now + BLOCKED_RETRY_MS,
      });
    if (reply.kind === "invalid")
      return save({
        ...note,
        failed: reply.message ?? "Shots could not accept this note.",
      });
    const attempts = note.attempts + 1;
    await save({
      ...note,
      attempts,
      nextAttemptAt: now + retryDelayMs(attempts),
      lastError: reply.message,
    });
    throw new Stop({
      status: "offline",
      message: reply.message,
      nextAttemptAt: now + retryDelayMs(attempts),
    });
  };
  const succeeded = (note: VoiceNoteState): VoiceNoteState => ({
    ...note,
    attempts: 0,
    nextAttemptAt: 0,
    blocked: null,
    lastError: null,
  });
  // 404: Shots does not know the id; the create is replayed after a wait to learn it.
  const lost = (note: VoiceNoteState) => {
    const attempts = note.attempts + 1;
    return save({
      ...note,
      remoteId: null,
      attempts,
      nextAttemptAt: now + retryDelayMs(attempts),
    });
  };

  const run = async (
    op: VoiceOp,
    note: VoiceNoteState,
    limits: VoiceSettings["limits"],
  ): Promise<VoiceNoteState | null> => {
    switch (op) {
      case "drop":
        await deps.remove(note.sessionId);
        return null;
      case "create": {
        note = await save({ ...note, createSent: true });
        const reply = await call({
          method: "POST",
          suffix: "notes",
          body: {
            clientNoteId: note.sessionId,
            recordedAt: note.recordedAt,
            recordedTimeZone: note.recordedTimeZone,
            locale: note.locale,
            durationMs: note.durationMs,
            audioUploadConsent: note.audioUploadConsent,
          },
        });
        if (reply.kind === "conflict")
          return save({ ...note, deletedRemote: true });
        // Deleted on the phone and refused by Shots: nothing is left to delete.
        if (reply.kind === "invalid" && note.localDeleted) {
          await deps.remove(note.sessionId);
          return null;
        }
        const detail =
          reply.kind === "ok" ? parseVoiceNoteDetail(reply.body) : null;
        if (!detail)
          return failed(
            note,
            reply.kind === "ok" ? { ...reply, kind: "retry" } : reply,
          );
        return save(
          succeeded({
            ...note,
            remoteId: detail.id,
            remoteRevision: detail.revision,
            deletedRemote: detail.deleted,
            command: detail.command,
          }),
        );
      }
      case "transcribe": {
        // The user's own transcript is sent, never replaced or raced (plan 5.1).
        if (deps.transcriptionRunning(note.sessionId)) {
          const attempts = note.attempts + 1;
          return save({
            ...note,
            attempts,
            nextAttemptAt: now + retryDelayMs(attempts),
          });
        }
        if (await deps.transcriptVersion(note.sessionId))
          return discover(
            await save({ ...note, onDevice: "done", lastError: null }),
          );
        let result: Awaited<ReturnType<VoiceEngineDeps["transcribe"]>>;
        stopIfInactive();
        try {
          result = await deps.transcribe(note.sessionId);
        } catch {
          const failures = note.onDeviceFailures + 1;
          if (failures < MAX_ON_DEVICE_FAILURES)
            return save({
              ...note,
              onDeviceFailures: failures,
              nextAttemptAt: now + retryDelayMs(failures),
              lastError:
                "On-device transcription failed. It will be tried again.",
            });
          // The note still syncs: audio, or the provider's transcript when one exists.
          result = null;
        }
        if (!result || !result.text.trim())
          return save({ ...note, onDevice: "done", lastError: null });
        const version = await deps.transcriptVersion(note.sessionId, [
          result.transcriptId,
        ]);
        const found = {
          source: "on_device" as const,
          sourceIds: [result.transcriptId],
          versionKey: version?.versionKey ?? `${result.transcriptId}:on-device`,
        };
        const revision = transcriptRevisionFor(found, note.sent);
        return save({
          ...note,
          onDevice: "done",
          lastError: null,
          pending: revision && {
            ...revision,
            ...found,
            text: result.text,
            engine: result.engine,
            locale: result.locale,
            segments: result.segments,
          },
        });
      }
      case "transcript": {
        const pending = note.pending!;
        const body = {
          clientRevisionId: pending.clientRevisionId,
          parentId: pending.parentId,
          origin: pending.origin,
          locale: pending.locale,
          engine: pending.engine && withoutNul(pending.engine),
          text: withoutNul(pending.text),
          segments: pending.segments.map((segment) => ({
            ...segment,
            text: withoutNul(segment.text),
          })),
        };
        const sent = (id: string | null) => ({
          id,
          sourceIds: pending.sourceIds,
          versionKey: pending.versionKey,
        });
        // Never resend a revision Shots rejected; a later edit is a new revision.
        const rejected = (
          reason: string,
          patch: Partial<VoiceNoteState> = {},
        ) =>
          save({
            ...note,
            pending: null,
            sent: sent(note.sent?.id ?? null),
            rejected: reason,
            ...patch,
          });
        if (
          characters(body.text) > limits.maxTranscriptChars ||
          body.segments.reduce(
            (total, segment) => total + characters(segment.text),
            0,
          ) > limits.maxTranscriptChars ||
          new TextEncoder().encode(JSON.stringify(body)).byteLength >
            MAX_VOICE_BODY_BYTES
        )
          return rejected(
            "The transcript is too long for Shots, so it was not sent.",
          );
        const reply = await call({
          method: "POST",
          suffix: `notes/${note.remoteId}/transcripts`,
          body,
        });
        if (reply.kind === "conflict") {
          if (reply.message === null || reply.message === NOTE_DELETED)
            return save({ ...note, deletedRemote: true, pending: null });
          // The note holds every revision Shots allows; later edits stay on the phone.
          return rejected(reply.message, { revisionsFull: true });
        }
        if (reply.kind === "not_found") return lost(note);
        if (reply.kind === "invalid")
          return rejected(
            `Shots did not accept the transcript.${reply.message ? ` ${reply.message}` : ""}`,
          );
        const result = reply.body as {
          revision?: { id?: unknown };
          note?: { revision?: unknown };
          command?: unknown;
        } | null;
        const id =
          typeof result?.revision?.id === "string" ? result.revision.id : null;
        if (reply.kind !== "ok" || !id)
          return failed(
            note,
            reply.kind === "ok" ? { ...reply, kind: "retry" } : reply,
          );
        const detail = parseVoiceNoteDetail({
          ...(result?.note ?? {}),
          command: result?.command,
        });
        return save(
          succeeded({
            ...note,
            pending: null,
            rejected: null,
            sent: sent(id),
            remoteRevision: detail?.revision ?? note.remoteRevision,
            command: detail ? detail.command : note.command,
          }),
        );
      }
      case "upload": {
        // Shots refuses a run outside its note length limits; never send one.
        if (
          note.durationMs !== null &&
          (note.durationMs > limits.maxNoteMs ||
            note.durationMs < limits.minNoteMs)
        )
          return save({
            ...note,
            audio: "unavailable",
            lastError:
              "The recording is longer or shorter than Shots accepts, so only the transcript was sent.",
          });
        const audio = await deps.audio(note.sessionId);
        if (!audio) return save({ ...note, audio: "unavailable" });
        // Shots stores WAV runs only.
        if (audio.contentType !== "audio/wav")
          return save({
            ...note,
            audio: "unavailable",
            lastError:
              "Shots accepts WAV recordings only, so only the transcript was sent.",
          });
        let upload = note.upload;
        if (!upload || Date.parse(upload.expiresAt) - 60_000 <= now) {
          const reply = await call({
            method: "POST",
            suffix: `notes/${note.remoteId}/runs/0/upload`,
            body: {
              contentType: audio.contentType,
              bytes: audio.bytes,
              sha256: audio.sha256,
              startOffsetMs: 0,
              durationMs: note.durationMs,
            },
          });
          if (reply.kind === "conflict")
            return save({ ...note, audio: "conflict" });
          if (reply.kind === "blocked" || reply.kind === "invalid")
            return save({
              ...note,
              audio: "unavailable",
              lastError: reply.message ?? "Shots did not accept the recording.",
            });
          if (reply.kind === "not_found") return lost(note);
          upload = reply.kind === "ok" ? parseVoiceUpload(reply.body) : null;
          if (!upload)
            return failed(
              note,
              reply.kind === "ok" ? { ...reply, kind: "retry" } : reply,
            );
          note = await save({ ...note, upload });
        }
        let status: number;
        try {
          status = await deps.put(note.sessionId, audio, upload);
        } catch {
          return failed(note, {
            kind: "retry",
            body: null,
            message: "The audio upload was interrupted.",
          });
        }
        // 412: the write-once object already holds this run.
        if ((status >= 200 && status < 300) || status === 412)
          return save(succeeded({ ...note, audio: "uploaded" }));
        const attempts = note.attempts + 1;
        return save({
          ...note,
          // An expired or refused URL is replaced; the whole run is sent again (S2, S3).
          upload: status === 400 || status === 403 ? null : upload,
          attempts,
          nextAttemptAt: now + retryDelayMs(attempts),
          lastError: "The audio upload did not finish. It will be sent again.",
        });
      }
      case "complete": {
        const reply = await call({
          method: "POST",
          suffix: `notes/${note.remoteId}/runs/0/complete`,
        });
        if (reply.kind === "ok")
          return save(succeeded({ ...note, audio: "done", upload: null }));
        // Final for this run (its audio was deleted, or it would pass 31
        // minutes) or audio upload was turned off since the URL was signed;
        // the note itself is in Shots.
        if (reply.kind === "conflict" || reply.kind === "blocked")
          return save({
            ...note,
            audio: "unavailable",
            upload: null,
            lastError: reply.message,
          });
        if (reply.kind === "invalid" || reply.kind === "not_found") {
          // S4: the stored object is missing or bad; send the run again, a few
          // times, since a recording Shots cannot decode never improves.
          const audioFailures = note.audioFailures + 1;
          if (audioFailures >= MAX_AUDIO_FAILURES)
            return save({
              ...note,
              audio: "unavailable",
              audioFailures,
              upload: null,
              lastError:
                reply.message ?? "Shots could not accept the recording.",
            });
          const attempts = note.attempts + 1;
          return save({
            ...note,
            audio: "todo",
            audioFailures,
            upload: null,
            attempts,
            nextAttemptAt: now + retryDelayMs(attempts),
            lastError: reply.message,
          });
        }
        return failed(note, reply);
      }
      case "delete": {
        const reply = await call({
          method: "DELETE",
          suffix: `notes/${note.remoteId}`,
        });
        if (reply.kind === "ok" || reply.kind === "not_found") {
          await deps.remove(note.sessionId);
          return null;
        }
        return failed(note, reply);
      }
    }
  };

  // Finds a transcript the note has not sent: the session's when nothing was
  // sent yet or the sent rows are gone, or an edit of the rows already sent.
  async function discover(note: VoiceNoteState) {
    if (note.revisionsFull) return note;
    const version =
      (note.sent &&
        (await deps.transcriptVersion(note.sessionId, note.sent.sourceIds))) ||
      (await deps.transcriptVersion(note.sessionId));
    if (!version) return note;
    const revision = transcriptRevisionFor(version, note.sent);
    if (!revision) return note;
    const text = await deps.transcriptText(note.sessionId, version.sourceIds);
    if (!text.trim()) return note;
    return save({
      ...note,
      pending: {
        ...revision,
        sourceIds: version.sourceIds,
        versionKey: version.versionKey,
        text,
        engine: version.engine,
        locale: note.locale,
        segments: [],
      },
    });
  }

  try {
    const reply = await call({ method: "GET", suffix: "settings" });
    if (reply.kind === "signed_out") return SIGNED_OUT;
    if (reply.kind === "blocked" || reply.kind === "not_found")
      return {
        status: "blocked",
        message: reply.message ?? NO_ACCESS_MESSAGE,
        nextAttemptAt: now + BLOCKED_RETRY_MS,
      };
    const settings =
      reply.kind === "ok" ? parseVoiceSettings(reply.body) : null;
    if (!settings)
      return {
        status: "offline",
        message: reply.message,
        nextAttemptAt: now + retryDelayMs(1),
      };
    if (!isAppVersionSupported(settings.minAppVersion, deps.appVersion))
      return {
        status: "update_required",
        message: `Update the app to send notes to Shots (version ${settings.minAppVersion} or later). Recording still works and your notes stay on this phone.`,
        nextAttemptAt: null,
      };
    if (!settings.workspace.voiceNotes || !settings.switches.notes)
      return {
        status: "disabled",
        message:
          "Voice notes are off in this Shots workspace. An owner or admin can turn them on in Shots. Your notes stay on this phone.",
        nextAttemptAt: null,
      };
    const audioAllowed =
      deps.uploadAudio &&
      settings.workspace.audioUpload &&
      settings.switches.audioUpload;

    const deleted = await deps.deletedSessions(
      deps
        .notes()
        .filter((note) => !note.localDeleted)
        .map((note) => note.sessionId),
    );
    for (const note of deps.notes())
      if (deleted.has(note.sessionId))
        await save({
          ...note,
          localDeleted: true,
          nextAttemptAt: 0,
          failed: null,
        });

    for (const initial of deps.notes()) {
      stopIfInactive();
      let note: VoiceNoteState | null = initial;
      try {
        // shortcut: edits and late transcripts are looked for only in the last
        // 30 days of notes, so a pass stays a few queries per recent note;
        // batch the reads if older notes matter.
        if (
          !note.pending &&
          note.onDevice === "done" &&
          !note.localDeleted &&
          !note.deletedRemote &&
          !note.failed &&
          note.nextAttemptAt <= now &&
          now - Date.parse(note.recordedAt) < EDIT_WINDOW_MS
        )
          note = await discover(note);
        for (let step = 0; note && step < MAX_STEPS_PER_NOTE; step += 1) {
          const op = nextVoiceOp(note, { now, audioAllowed });
          if (!op) break;
          note = await run(op, note, settings.limits);
        }
      } catch (error) {
        if (error instanceof Stop) throw error;
        // One note's broken data must not hold the notes after it.
        deps.report(error);
        const latest = deps
          .notes()
          .find((item) => item.sessionId === initial.sessionId);
        if (latest) {
          const attempts = latest.attempts + 1;
          await save({
            ...latest,
            attempts,
            nextAttemptAt: now + retryDelayMs(attempts),
            lastError:
              "This note could not be prepared. It will be tried again.",
          });
        }
      }
    }

    const index = await call({ method: "GET", suffix: "notes/index" });
    if (index.kind === "signed_out") return SIGNED_OUT;
    const pulled = new Set<string>();
    const pull = async (id: string) => {
      if (pulled.has(id)) return;
      pulled.add(id);
      const reply = await call({ method: "GET", suffix: `notes/${id}` });
      const detail =
        reply.kind === "ok" ? parseVoiceNoteDetail(reply.body) : null;
      const note =
        detail &&
        deps.notes().find((item) => item.sessionId === detail.clientNoteId);
      if (
        note &&
        (note.remoteId !== detail.id ||
          note.remoteRevision !== detail.revision ||
          note.deletedRemote !== detail.deleted ||
          JSON.stringify(note.command) !== JSON.stringify(detail.command))
      )
        await save({
          ...note,
          remoteId: detail.id,
          remoteRevision: detail.revision,
          deletedRemote: detail.deleted,
          command: detail.command,
        });
    };
    for (const diff of diffVoiceIndex(
      deps.notes(),
      parseVoiceIndex(index.body) ?? [],
    )) {
      if (diff.kind === "deleted")
        // S7, S8: delete wins; the local Anarlog note is kept and labelled.
        await save({
          ...diff.note,
          deletedRemote: true,
          remoteId: diff.entry.id,
          remoteRevision: diff.entry.revision,
          pending: null,
          upload: null,
          command: null,
        });
      else if (diff.kind === "changed") await pull(diff.entry.id);
    }
    // A parse finished by the server's sweep does not change the note's revision.
    for (const note of deps.notes())
      if (
        note.remoteId &&
        !note.deletedRemote &&
        ["waiting", "proposed"].includes(note.command?.status ?? "")
      )
        await pull(note.remoteId);

    // A sent note past the edit window has nothing left to send; forgetting it
    // keeps the stored queue small (the note stays on the phone).
    for (const note of deps.notes())
      if (
        now - Date.parse(note.recordedAt) >= EDIT_WINDOW_MS &&
        !note.failed &&
        !note.blocked &&
        note.nextAttemptAt <= now &&
        !isVoiceNoteUnsent(note) &&
        !nextVoiceOp(note, { now, audioAllowed }) &&
        !["waiting", "proposed"].includes(note.command?.status ?? "")
      )
        await deps.remove(note.sessionId);

    const due = deps
      .notes()
      .filter(
        (note) =>
          !note.failed && !note.deletedRemote && note.nextAttemptAt > now,
      )
      .map((note) => note.nextAttemptAt);
    return {
      status: "idle",
      message: null,
      nextAttemptAt: due.length ? Math.min(...due) : null,
    };
  } catch (error) {
    if (error instanceof Stop) return error.result;
    throw error;
  }
}

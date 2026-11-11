import {
  BLOCKED_RETRY_MS,
  MAX_ON_DEVICE_FAILURES,
  classifyVoiceStatus,
  diffVoiceIndex,
  isAppVersionSupported,
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
} from "./model.ts";

// One sync pass for one account's queue in one Shots workspace (plan 5.2 "Sync"):
// read settings, push each note's pending work idempotently, then compare the
// note index and pull what changed. Every effect goes through `deps`.

export type VoiceRequest = {
  method: "GET" | "POST" | "DELETE";
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
    sourceIds: string[];
    versionKey: string;
    engine: string | null;
  } | null>;
  transcriptText: (sessionId: string, ids: string[]) => Promise<string>;
  deletedSessions: (sessionIds: string[]) => Promise<Set<string>>;
  notes: () => VoiceNoteState[];
  save: (note: VoiceNoteState) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
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
  const call = async (request: VoiceRequest): Promise<Reply> => {
    if (!deps.isActive(deps.accountId, deps.workspaceId))
      throw new Stop({
        status: "inactive",
        message: null,
        nextAttemptAt: null,
      });
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

  const run = async (
    op: VoiceOp,
    note: VoiceNoteState,
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
        let result: Awaited<ReturnType<VoiceEngineDeps["transcribe"]>>;
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
        const reply = await call({
          method: "POST",
          suffix: `notes/${note.remoteId}/transcripts`,
          body: {
            clientRevisionId: pending.clientRevisionId,
            parentId: pending.parentId,
            origin: pending.origin,
            locale: pending.locale,
            engine: pending.engine,
            text: pending.text,
            segments: pending.segments,
          },
        });
        const sent = (id: string | null) => ({
          id,
          sourceIds: pending.sourceIds,
          versionKey: pending.versionKey,
        });
        if (reply.kind === "conflict")
          return save({ ...note, deletedRemote: true, pending: null });
        if (reply.kind === "not_found")
          return save({ ...note, remoteId: null });
        if (reply.kind === "invalid")
          // Never resend a revision Shots rejected; a later edit is a new revision.
          return save({
            ...note,
            pending: null,
            sent: sent(note.sent?.id ?? null),
            lastError: reply.message,
          });
        const body = reply.body as {
          revision?: { id?: unknown };
          note?: { revision?: unknown };
          command?: unknown;
        } | null;
        const id =
          typeof body?.revision?.id === "string" ? body.revision.id : null;
        if (reply.kind !== "ok" || !id)
          return failed(
            note,
            reply.kind === "ok" ? { ...reply, kind: "retry" } : reply,
          );
        const detail = parseVoiceNoteDetail({
          ...(body?.note ?? {}),
          command: body?.command,
        });
        return save(
          succeeded({
            ...note,
            pending: null,
            sent: sent(id),
            remoteRevision: detail?.revision ?? note.remoteRevision,
            command: detail ? detail.command : note.command,
          }),
        );
      }
      case "upload": {
        const audio = await deps.audio(note.sessionId);
        if (!audio || !["audio/wav", "audio/aac"].includes(audio.contentType))
          return save({ ...note, audio: "unavailable" });
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
          if (reply.kind === "blocked")
            return save({
              ...note,
              audio: "unavailable",
              lastError: reply.message,
            });
          if (reply.kind === "not_found")
            return save({ ...note, remoteId: null });
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
        if (reply.kind === "conflict")
          return save({ ...note, audio: "conflict" });
        if (reply.kind === "invalid" || reply.kind === "not_found") {
          // S4: the stored object is missing or bad; send the run again.
          const attempts = note.attempts + 1;
          return save({
            ...note,
            audio: "todo",
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

  // Finds a transcript the note has not sent: the provider's when nothing was
  // sent yet, or an edit of the rows already sent.
  const discover = async (note: VoiceNoteState) => {
    const version = note.sent
      ? await deps.transcriptVersion(note.sessionId, note.sent.sourceIds)
      : await deps.transcriptVersion(note.sessionId);
    if (!version) return note;
    const revision = transcriptRevisionFor(
      { source: "provider", ...version },
      note.sent,
    );
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
  };

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
      let note: VoiceNoteState | null = initial;
      if (
        !note.pending &&
        note.onDevice === "done" &&
        !note.localDeleted &&
        !note.deletedRemote
      )
        note = await discover(note);
      for (let step = 0; note && step < MAX_STEPS_PER_NOTE; step += 1) {
        const op = nextVoiceOp(note, { now, audioAllowed });
        if (!op) break;
        note = await run(op, note);
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
      if (note)
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

import { sha256 } from "js-sha256";

// Shots voice notes sync (Shots voice capture plan 5.1-5.4). Pure rules shared
// by the sync engine and the UI; the JSON shapes are the Shots voice API's.

export type VoiceSegment = {
  startMs: number;
  endMs: number;
  text: string;
  approximate?: boolean;
};

export type VoiceCommandCandidate = {
  channelConnectionId: string;
  platform: string;
  name: string;
};

export type VoiceCommand = {
  id: string;
  transcriptRevisionId: string;
  status: string;
  action: string;
  platform: string | null;
  text: string | null;
  localTime: string | null;
  timeZone: string;
  scheduledFor: string | null;
  channelConnectionId: string | null;
  candidates: VoiceCommandCandidate[];
  guessed: string[];
  flags: string[];
  addedWords: string[];
  notice: string | null;
  outcome: string | null;
  failureReason: string | null;
  expiresAt: string | null;
};

export type VoiceSettings = {
  workspace: {
    voiceNotes: boolean;
    audioUpload: boolean;
    voiceCommands: boolean;
  };
  member: { remoteTextConsentAt: string | null; voiceCommands: boolean };
  minAppVersion: string;
  limits: { maxNoteMs: number; minNoteMs: number; maxTranscriptChars: number };
  switches: { notes: boolean; audioUpload: boolean; parse: boolean };
};

export type VoiceIndexEntry = {
  id: string;
  clientNoteId: string;
  revision: number;
  deleted: boolean;
};

export type VoiceNoteDetail = VoiceIndexEntry & {
  command: VoiceCommand | null;
};

export type VoiceOrigin = "on_device" | "remote" | "user_edit";

export type PendingRevision = {
  origin: VoiceOrigin;
  clientRevisionId: string;
  parentId: string | null;
  text: string;
  engine: string | null;
  locale: string | null;
  segments: VoiceSegment[];
  sourceIds: string[];
  versionKey: string;
};

/** One phone recording queued for one account and workspace. */
export type VoiceNoteState = {
  sessionId: string;
  recordedAt: string;
  recordedTimeZone: string;
  locale: string | null;
  durationMs: number | null;
  audioUploadConsent: boolean;
  remoteId: string | null;
  remoteRevision: number | null;
  createSent: boolean;
  onDevice: "todo" | "done";
  onDeviceFailures: number;
  pending: PendingRevision | null;
  sent: { id: string | null; sourceIds: string[]; versionKey: string } | null;
  audio: "todo" | "uploaded" | "done" | "unavailable" | "conflict";
  /** Uploads Shots could not verify; a successful PUT does not reset it. */
  audioFailures: number;
  upload: {
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  } | null;
  localDeleted: boolean;
  deletedRemote: boolean;
  blocked: string | null;
  failed: string | null;
  /** Why Shots did not take the latest transcript; the note itself is in Shots. */
  rejected: string | null;
  /** Shots holds the most revisions a note may have; no more are sent. */
  revisionsFull: boolean;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  command: VoiceCommand | null;
};

export type VoiceOp =
  | "create"
  | "transcribe"
  | "transcript"
  | "upload"
  | "complete"
  | "delete"
  | "drop";

export type VoiceOutcome =
  | "ok"
  | "retry"
  | "signed_out"
  | "blocked"
  | "not_found"
  | "conflict"
  | "invalid";

export const BLOCKED_RETRY_MS = 6 * 60 * 60 * 1000;
export const MAX_ON_DEVICE_FAILURES = 5;
export const MAX_AUDIO_FAILURES = 3;

export function newVoiceNote(input: {
  sessionId: string;
  recordedAt: string;
  recordedTimeZone: string;
  locale: string | null;
  durationMs: number | null;
  audioUploadConsent: boolean;
}): VoiceNoteState {
  return {
    ...input,
    remoteId: null,
    remoteRevision: null,
    createSent: false,
    onDevice: "todo",
    onDeviceFailures: 0,
    pending: null,
    sent: null,
    audio: "todo",
    audioFailures: 0,
    upload: null,
    localDeleted: false,
    deletedRemote: false,
    blocked: null,
    failed: null,
    rejected: null,
    revisionsFull: false,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    command: null,
  };
}

/** The next request for a note, or null when it waits or is finished. */
export function nextVoiceOp(
  note: VoiceNoteState,
  context: { now: number; audioAllowed: boolean },
): VoiceOp | null {
  if (note.deletedRemote) return note.localDeleted ? "drop" : null;
  if (note.failed || note.nextAttemptAt > context.now) return null;
  if (note.localDeleted) {
    // A create whose response was lost may have made the note: replay it to learn its id.
    return note.remoteId ? "delete" : note.createSent ? "create" : "drop";
  }
  if (!note.remoteId) return "create";
  if (note.onDevice === "todo") return "transcribe";
  if (note.pending) return "transcript";
  if (!context.audioAllowed || !note.audioUploadConsent) return null;
  if (note.audio === "todo") return "upload";
  if (note.audio === "uploaded") return "complete";
  return null;
}

/** Work that has not reached Shots yet (shown before sign-out and workspace switches, S12, S13). */
export function isVoiceNoteUnsent(note: VoiceNoteState): boolean {
  return (
    !note.deletedRemote &&
    (note.localDeleted ||
      !note.remoteId ||
      note.onDevice === "todo" ||
      note.pending !== null ||
      note.audio === "uploaded")
  );
}

/** The note's Shots state in one line. */
export function voiceNoteStatusText(note: VoiceNoteState): string {
  if (note.deletedRemote)
    return "Deleted in Shots. This note stays on your phone and is no longer sent.";
  if (note.failed) return `Not sent to Shots: ${note.failed}`;
  if (note.blocked) return note.blocked;
  if (isVoiceNoteUnsent(note))
    return note.lastError
      ? `Waiting to send to Shots. ${note.lastError}`
      : "Waiting to send to Shots.";
  const problem = note.rejected ?? note.lastError;
  return problem ? `Sent to Shots. ${problem}` : "Sent to Shots.";
}

/** Section 4 status semantics: 401 expired session, 403 not allowed, 404, 409 deleted or checksum conflict, 400 invalid. */
export function classifyVoiceStatus(status: number): VoiceOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "signed_out";
  if (status === 403) return "blocked";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 413 || status === 422) return "invalid";
  return "retry";
}

export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

/**
 * The wait before the next pass: what the pass asked for, but consecutive
 * offline passes back off like a note's retries, with jitter (`random` in
 * [0, 1)) so phones do not retry in step.
 */
export function nextPassDelayMs(
  wait: number,
  offlinePasses: number,
  random: number,
): number {
  const backoff =
    offlinePasses > 0 ? retryDelayMs(offlinePasses) * (0.75 + random / 2) : 0;
  return Math.round(Math.min(Math.max(wait, backoff, 1_000), 2 ** 31 - 1));
}

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** S17: sync stops (recording never does) when Shots needs a newer app. An unreadable minimum blocks sync. */
export function isAppVersionSupported(
  minAppVersion: string,
  appVersion: string,
): boolean {
  const minimum = versionParts(minAppVersion);
  const current = versionParts(appVersion);
  if (!minimum || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! !== minimum[index]!)
      return current[index]! > minimum[index]!;
  }
  return true;
}

export type VoiceIndexDiff =
  | { kind: "new"; entry: VoiceIndexEntry }
  | {
      kind: "changed" | "deleted" | "tombstone" | "unchanged";
      entry: VoiceIndexEntry;
      note: VoiceNoteState;
    };

/** Plan decision 8: sync is a list comparison of (id, revision, deleted), matched by client note id. */
export function diffVoiceIndex(
  notes: VoiceNoteState[],
  entries: VoiceIndexEntry[],
): VoiceIndexDiff[] {
  const bySession = new Map(notes.map((note) => [note.sessionId, note]));
  return entries.map((entry) => {
    const note = bySession.get(entry.clientNoteId);
    if (!note) return { kind: "new", entry };
    if (entry.deleted)
      return {
        kind: note.deletedRemote ? "tombstone" : "deleted",
        entry,
        note,
      };
    if (note.remoteId !== entry.id || note.remoteRevision !== entry.revision)
      return { kind: "changed", entry, note };
    return { kind: "unchanged", entry, note };
  });
}

/**
 * Maps a local transcript version to the revision Shots should receive, or
 * null when that version was already sent. The same transcript rows with new
 * content are the user's edit; anything else is a machine transcript.
 */
export function transcriptRevisionFor(
  found: {
    source: "on_device" | "provider";
    sourceIds: string[];
    versionKey: string;
  },
  sent: VoiceNoteState["sent"],
): {
  origin: VoiceOrigin;
  clientRevisionId: string;
  parentId: string | null;
} | null {
  const sameRows =
    sent !== null &&
    sent.sourceIds.length === found.sourceIds.length &&
    sent.sourceIds.every((id, index) => id === found.sourceIds[index]);
  if (sameRows && sent.versionKey === found.versionKey) return null;
  return {
    origin: sameRows
      ? "user_edit"
      : found.source === "on_device"
        ? "on_device"
        : "remote",
    clientRevisionId: `anarlog-${sha256(found.versionKey).slice(0, 40)}`,
    parentId: sent?.id ?? null,
  };
}

// The gateway's own errors carry a code where Shots' carry a sentence.
const GATEWAY_ERRORS: Record<string, string> = {
  shots_voice_unavailable: "Shots could not be reached.",
  invalid_token: "Sign in again to use Shots.",
  invalid_voice_path: "Update the app to send notes to Shots.",
  invalid_voice_query: "Update the app to send notes to Shots.",
};

export function voiceErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { message, msg, code } = body as {
    message?: unknown;
    msg?: unknown;
    code?: unknown;
  };
  const text = typeof message === "string" ? message : msg;
  if (typeof text !== "string" || !text.trim()) return null;
  if (text === code) return GATEWAY_ERRORS[text] ?? null;
  return text.slice(0, 300);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const text = (value: unknown) => (typeof value === "string" ? value : null);
const texts = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export function parseVoiceCommand(value: unknown): VoiceCommand | null {
  if (!isRecord(value) || !text(value.id) || !text(value.status)) return null;
  return {
    id: value.id as string,
    transcriptRevisionId: text(value.transcriptRevisionId) ?? "",
    status: value.status as string,
    action: text(value.action) ?? "none",
    platform: text(value.platform),
    text: text(value.text),
    localTime: text(value.localTime),
    timeZone: text(value.timeZone) ?? "UTC",
    scheduledFor: text(value.scheduledFor),
    channelConnectionId: text(value.channelConnectionId),
    candidates: (Array.isArray(value.candidates) ? value.candidates : [])
      .filter(isRecord)
      .flatMap((candidate) =>
        text(candidate.channelConnectionId)
          ? [
              {
                channelConnectionId: candidate.channelConnectionId as string,
                platform: text(candidate.platform) ?? "",
                name: text(candidate.name) ?? "",
              },
            ]
          : [],
      ),
    guessed: texts(value.guessed),
    flags: texts(value.flags),
    addedWords: texts(value.addedWords),
    notice: text(value.notice),
    outcome: text(value.outcome),
    failureReason: text(value.failureReason),
    expiresAt: text(value.expiresAt),
  };
}

export function parseVoiceIndexEntry(value: unknown): VoiceIndexEntry | null {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !text(value.clientNoteId) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.deleted !== "boolean"
  )
    return null;
  return {
    id: value.id as string,
    clientNoteId: value.clientNoteId as string,
    revision: value.revision as number,
    deleted: value.deleted,
  };
}

export function parseVoiceNoteDetail(value: unknown): VoiceNoteDetail | null {
  const entry = parseVoiceIndexEntry(value);
  if (!entry || !isRecord(value)) return null;
  return { ...entry, command: parseVoiceCommand(value.command) };
}

export function parseVoiceIndex(value: unknown): VoiceIndexEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.notes)) return null;
  return value.notes.flatMap((entry) => {
    const parsed = parseVoiceIndexEntry(entry);
    return parsed ? [parsed] : [];
  });
}

export function parseVoiceSettings(value: unknown): VoiceSettings | null {
  if (
    !isRecord(value) ||
    !isRecord(value.workspace) ||
    !isRecord(value.member) ||
    !isRecord(value.switches) ||
    typeof value.minAppVersion !== "string" ||
    !isRecord(value.limits) ||
    !isCount(value.limits.maxNoteMs) ||
    !isCount(value.limits.minNoteMs) ||
    !isCount(value.limits.maxTranscriptChars)
  )
    return null;
  const { workspace, member, switches, limits } = value;
  return {
    workspace: {
      voiceNotes: workspace.voiceNotes === true,
      audioUpload: workspace.audioUpload === true,
      voiceCommands: workspace.voiceCommands === true,
    },
    member: {
      remoteTextConsentAt: text(member.remoteTextConsentAt),
      voiceCommands: member.voiceCommands === true,
    },
    minAppVersion: value.minAppVersion,
    limits: {
      maxNoteMs: limits.maxNoteMs as number,
      minNoteMs: limits.minNoteMs as number,
      maxTranscriptChars: limits.maxTranscriptChars as number,
    },
    switches: {
      notes: switches.notes === true,
      audioUpload: switches.audioUpload === true,
      parse: switches.parse === true,
    },
  };
}

export function parseVoiceUpload(value: unknown): VoiceNoteState["upload"] {
  if (
    !isRecord(value) ||
    !text(value.url) ||
    !text(value.expiresAt) ||
    !isRecord(value.headers)
  )
    return null;
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value.headers))
    if (typeof header === "string") headers[name] = header;
  return {
    url: value.url as string,
    headers,
    expiresAt: value.expiresAt as string,
  };
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown) => typeof value === "boolean";
const orNull =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || check(value);
const isTexts = (value: unknown) => Array.isArray(value) && value.every(isText);
const STORED_FIELDS: {
  [K in Exclude<keyof VoiceNoteState, "upload" | "command">]: (
    value: unknown,
  ) => boolean;
} = {
  sessionId: isText,
  recordedAt: isText,
  recordedTimeZone: isText,
  locale: orNull(isText),
  durationMs: orNull(isNumber),
  audioUploadConsent: isBoolean,
  remoteId: orNull(isText),
  remoteRevision: orNull(isNumber),
  createSent: isBoolean,
  onDevice: (value) => value === "todo" || value === "done",
  onDeviceFailures: isNumber,
  pending: orNull(
    (value) =>
      isRecord(value) &&
      ["on_device", "remote", "user_edit"].includes(value.origin as string) &&
      isText(value.clientRevisionId) &&
      orNull(isText)(value.parentId) &&
      isText(value.text) &&
      orNull(isText)(value.engine) &&
      orNull(isText)(value.locale) &&
      Array.isArray(value.segments) &&
      value.segments.every(
        (segment) =>
          isRecord(segment) &&
          isNumber(segment.startMs) &&
          isNumber(segment.endMs) &&
          isText(segment.text),
      ) &&
      isTexts(value.sourceIds) &&
      isText(value.versionKey),
  ),
  sent: orNull(
    (value) =>
      isRecord(value) &&
      orNull(isText)(value.id) &&
      isTexts(value.sourceIds) &&
      isText(value.versionKey),
  ),
  audio: (value) =>
    ["todo", "uploaded", "done", "unavailable", "conflict"].includes(
      value as string,
    ),
  audioFailures: isNumber,
  localDeleted: isBoolean,
  deletedRemote: isBoolean,
  blocked: orNull(isText),
  failed: orNull(isText),
  rejected: orNull(isText),
  revisionsFull: isBoolean,
  attempts: isNumber,
  nextAttemptAt: isNumber,
  lastError: orNull(isText),
};

/** A queued note read back from storage, null without a session id; a field of the wrong shape takes its default. */
export function parseStoredVoiceNote(value: unknown): VoiceNoteState | null {
  if (!isRecord(value) || !isText(value.sessionId)) return null;
  const note: Record<string, unknown> = {
    ...newVoiceNote({
      sessionId: value.sessionId,
      recordedAt: "",
      recordedTimeZone: "UTC",
      locale: null,
      durationMs: null,
      audioUploadConsent: false,
    }),
    upload: parseVoiceUpload(value.upload),
    command: parseVoiceCommand(value.command),
  };
  for (const [key, valid] of Object.entries(STORED_FIELDS))
    if (valid(value[key])) note[key] = value[key];
  return note as VoiceNoteState;
}

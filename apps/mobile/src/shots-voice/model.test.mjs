import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVoiceStatus,
  diffVoiceIndex,
  isAppVersionSupported,
  newVoiceNote,
  nextVoiceOp,
  parseStoredVoiceNote,
  parseVoiceSettings,
  retryDelayMs,
  transcriptRevisionFor,
} from "./model.ts";

const note = (sessionId, patch = {}) => ({
  ...newVoiceNote({
    sessionId,
    recordedAt: "2026-11-10T23:50:00.000Z",
    recordedTimeZone: "America/New_York",
    locale: "en",
    durationMs: 4000,
    audioUploadConsent: false,
  }),
  ...patch,
});

test("index comparison finds new, changed, newly deleted, known tombstone and unchanged notes", () => {
  const notes = [
    note("changed", { remoteId: "n1", remoteRevision: 1 }),
    note("deleted", { remoteId: "n2", remoteRevision: 3 }),
    note("tombstone", {
      remoteId: "n3",
      remoteRevision: 4,
      deletedRemote: true,
    }),
    note("same", { remoteId: "n4", remoteRevision: 2 }),
    note("lost-create", { createSent: true }),
  ];
  const kinds = diffVoiceIndex(notes, [
    { id: "n1", clientNoteId: "changed", revision: 2, deleted: false },
    { id: "n2", clientNoteId: "deleted", revision: 4, deleted: true },
    { id: "n3", clientNoteId: "tombstone", revision: 4, deleted: true },
    { id: "n4", clientNoteId: "same", revision: 2, deleted: false },
    { id: "n5", clientNoteId: "lost-create", revision: 1, deleted: false },
    { id: "n6", clientNoteId: "other-device", revision: 1, deleted: false },
  ]).map((diff) => [diff.entry.clientNoteId, diff.kind]);
  assert.deepEqual(kinds, [
    ["changed", "changed"],
    ["deleted", "deleted"],
    ["tombstone", "tombstone"],
    ["same", "unchanged"],
    // A create whose response was lost is adopted from the index.
    ["lost-create", "changed"],
    ["other-device", "new"],
  ]);
});

test("response classes follow the voice API status semantics", () => {
  assert.deepEqual(
    [200, 201, 204, 400, 401, 403, 404, 409, 408, 429, 500, 502].map(
      classifyVoiceStatus,
    ),
    [
      "ok",
      "ok",
      "ok",
      "invalid",
      "signed_out",
      "blocked",
      "not_found",
      "conflict",
      "retry",
      "retry",
      "retry",
      "retry",
    ],
  );
  assert.deepEqual(
    [1, 2, 3, 20].map(retryDelayMs),
    [30_000, 60_000, 120_000, 3_600_000],
  );
});

test("sync stops only when Shots needs a newer app than this one", () => {
  assert.equal(isAppVersionSupported("0.1.9", "0.1.9"), true);
  assert.equal(isAppVersionSupported("0.1.10", "0.1.9"), false);
  assert.equal(isAppVersionSupported("1.0.0", "0.1.9"), false);
  assert.equal(isAppVersionSupported("0.1.2", "0.10.0"), true);
  assert.equal(isAppVersionSupported("v0.1.0", "0.1.9-beta.1"), true);
  assert.equal(isAppVersionSupported("latest", "0.1.9"), false);
});

test("transcript versions map to origins and stable client revision ids", () => {
  const onDevice = transcriptRevisionFor(
    { source: "on_device", sourceIds: ["t1"], versionKey: "t1:v1" },
    null,
  );
  assert.equal(onDevice.origin, "on_device");
  assert.equal(onDevice.parentId, null);
  assert.match(onDevice.clientRevisionId, /^anarlog-[0-9a-f]{40}$/);
  assert.equal(
    transcriptRevisionFor(
      { source: "on_device", sourceIds: ["t1"], versionKey: "t1:v1" },
      null,
    ).clientRevisionId,
    onDevice.clientRevisionId,
  );

  const sent = { id: "rev-1", sourceIds: ["t1"], versionKey: "t1:v1" };
  assert.equal(
    transcriptRevisionFor(
      { source: "provider", sourceIds: ["t1"], versionKey: "t1:v1" },
      sent,
    ),
    null,
  );
  const edit = transcriptRevisionFor(
    { source: "provider", sourceIds: ["t1"], versionKey: "t1:v2" },
    sent,
  );
  assert.equal(edit.origin, "user_edit");
  assert.equal(edit.parentId, "rev-1");
  assert.notEqual(edit.clientRevisionId, onDevice.clientRevisionId);
  assert.equal(
    transcriptRevisionFor(
      { source: "provider", sourceIds: ["live", "batch"], versionKey: "x" },
      null,
    ).origin,
    "remote",
  );
});

test("each note does create, transcription, transcript, then audio, and local deletes win", () => {
  const ready = { now: 1_000, audioAllowed: true };
  assert.equal(nextVoiceOp(note("a"), ready), "create");
  assert.equal(nextVoiceOp(note("a", { remoteId: "n" }), ready), "transcribe");
  const transcribed = { remoteId: "n", onDevice: "done" };
  assert.equal(
    nextVoiceOp(note("a", { ...transcribed, pending: {} }), ready),
    "transcript",
  );
  assert.equal(nextVoiceOp(note("a", transcribed), ready), null);
  const consented = { ...transcribed, audioUploadConsent: true };
  assert.equal(nextVoiceOp(note("a", consented), ready), "upload");
  assert.equal(
    nextVoiceOp(note("a", consented), { ...ready, audioAllowed: false }),
    null,
  );
  assert.equal(
    nextVoiceOp(note("a", { ...consented, audio: "uploaded" }), ready),
    "complete",
  );
  assert.equal(
    nextVoiceOp(note("a", { remoteId: "n", nextAttemptAt: 2_000 }), ready),
    null,
  );
  assert.equal(
    nextVoiceOp(note("a", { localDeleted: true, remoteId: "n" }), ready),
    "delete",
  );
  assert.equal(
    nextVoiceOp(note("a", { localDeleted: true, createSent: true }), ready),
    "create",
  );
  assert.equal(nextVoiceOp(note("a", { localDeleted: true }), ready), "drop");
  assert.equal(nextVoiceOp(note("a", { deletedRemote: true }), ready), null);
});

test("settings carry the note limits the phone applies, and settings without them are refused", () => {
  const body = {
    workspace: { voiceNotes: true, audioUpload: true, voiceCommands: false },
    member: { remoteTextConsentAt: null, voiceCommands: false },
    minAppVersion: "0.1.0",
    limits: {
      maxNoteMs: 1_800_000,
      warnAtMs: 1_500_000,
      minNoteMs: 1_000,
      maxTranscriptChars: 100_000,
      maxCommandChars: 2_000,
    },
    switches: { notes: true, audioUpload: true, parse: false },
  };
  assert.deepEqual(parseVoiceSettings(body).limits, {
    maxNoteMs: 1_800_000,
    minNoteMs: 1_000,
    maxTranscriptChars: 100_000,
  });
  assert.equal(parseVoiceSettings({ ...body, limits: undefined }), null);
  assert.equal(
    parseVoiceSettings({
      ...body,
      limits: { ...body.limits, maxNoteMs: "30m" },
    }),
    null,
  );
});

test("a stored note keeps its valid fields and defaults the malformed ones", () => {
  const stored = {
    ...note("a", { remoteId: "n1", onDevice: "done", attempts: 2 }),
    sent: { id: "rev-1", sourceIds: "t1", versionKey: "t1:v1" },
    pending: { origin: "machine", text: "hi" },
    audio: "lost",
    nextAttemptAt: "soon",
    command: { status: "proposed" },
    upload: { url: "https://storage.test/run", headers: {}, expiresAt: "x" },
  };
  const parsed = parseStoredVoiceNote(stored);
  assert.equal(parsed.remoteId, "n1");
  assert.equal(parsed.onDevice, "done");
  assert.equal(parsed.attempts, 2);
  assert.equal(parsed.recordedTimeZone, "America/New_York");
  assert.equal(parsed.sent, null);
  assert.equal(parsed.pending, null);
  assert.equal(parsed.audio, "todo");
  assert.equal(parsed.nextAttemptAt, 0);
  assert.equal(parsed.command, null);
  assert.deepEqual(parsed.upload, stored.upload);
  assert.equal(parsed.audioFailures, 0);
  assert.equal(parseStoredVoiceNote({ remoteId: "n1" }), null);
  assert.equal(parseStoredVoiceNote("a"), null);
  assert.deepEqual(parseStoredVoiceNote(note("b")), note("b"));
});

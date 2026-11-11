import assert from "node:assert/strict";
import test from "node:test";

import { runVoicePass } from "./engine.ts";
import { newVoiceNote } from "./model.ts";

const settings = (patch = {}) => ({
  workspace: {
    voiceNotes: true,
    audioUpload: true,
    draftGeneration: false,
    voiceCommands: false,
  },
  member: { remoteTextConsentAt: null, voiceCommands: false },
  canManage: false,
  minAppVersion: "0.1.0",
  switches: {
    notes: true,
    audioUpload: true,
    drafts: true,
    parse: true,
    confirm: true,
  },
  ...patch,
});

// The Shots voice API's idempotency rules, in memory.
function fakeShots() {
  const notes = new Map();
  const shots = {
    notes,
    requests: [],
    settings: settings(),
    override: undefined,
    handle(workspaceId, { method, suffix, body }) {
      shots.requests.push({ workspaceId, method, suffix, body });
      const forced = shots.override?.(method, suffix);
      if (forced) return forced;
      const [, id, kind, runIndex, runAction] = suffix.split("/");
      const note = [...notes.values()].find((item) => item.id === id);
      const view = (item) => ({
        id: item.id,
        clientNoteId: item.clientNoteId,
        revision: item.revision,
        deleted: item.deleted,
      });
      if (suffix === "settings") return { status: 200, body: shots.settings };
      if (suffix === "notes/index")
        return { status: 200, body: { notes: [...notes.values()].map(view) } };
      if (method === "POST" && suffix === "notes") {
        const existing = notes.get(body.clientNoteId);
        if (existing?.deleted)
          return {
            status: 409,
            body: { message: "This voice note was deleted." },
          };
        if (existing)
          return { status: 200, body: { ...view(existing), command: null } };
        const created = {
          id: `note-${notes.size + 1}`,
          clientNoteId: body.clientNoteId,
          revision: 1,
          deleted: false,
          revisions: new Map(),
          runs: new Map(),
          body,
        };
        notes.set(body.clientNoteId, created);
        return { status: 201, body: { ...view(created), command: null } };
      }
      if (!note)
        return {
          status: 404,
          body: { message: "This voice note was not found." },
        };
      if (method === "GET" && !kind)
        return {
          status: 200,
          body: { ...view(note), command: note.command ?? null },
        };
      if (method === "DELETE") {
        note.deleted = true;
        note.revision += 1;
        return { status: 204, body: null };
      }
      if (note.deleted)
        return {
          status: 409,
          body: { message: "This voice note was deleted." },
        };
      if (kind === "transcripts") {
        let revision = note.revisions.get(body.clientRevisionId);
        if (!revision) {
          revision = { id: `rev-${note.revisions.size + 1}`, ...body };
          note.revisions.set(body.clientRevisionId, revision);
          note.revision += 1;
        }
        return {
          status: 200,
          body: {
            revision: { id: revision.id },
            note: view(note),
            command: note.command ?? null,
          },
        };
      }
      if (kind === "runs" && runAction === "upload") {
        note.runs.set(runIndex, { ...body, status: "pending" });
        return {
          status: 200,
          body: {
            url: `https://storage.test/${note.id}/${runIndex}`,
            method: "PUT",
            headers: { "Content-Type": body.contentType },
            expiresAt: new Date(shots.now() + 15 * 60_000).toISOString(),
          },
        };
      }
      if (kind === "runs" && runAction === "complete") {
        const run = note.runs.get(runIndex);
        if (!run?.stored)
          return { status: 400, body: { message: "Upload the run again." } };
        run.status = "available";
        return { status: 200, body: { runIndex: 0, status: "available" } };
      }
      return { status: 400, body: null };
    },
  };
  return shots;
}

function harness({ shots = fakeShots(), queued = [], ...overrides } = {}) {
  let notes = queued;
  // The phone's transcripts: sessionId -> the version of its rows.
  const local = new Map();
  const transcribed = [];
  const clock = { now: Date.parse("2026-11-11T12:00:00Z") };
  shots.now = () => clock.now;
  const puts = [];
  const deps = {
    accountId: "account-a",
    workspaceId: "workspace-1",
    isActive: (accountId, workspaceId) =>
      accountId === "account-a" && workspaceId === "workspace-1",
    request: async (workspaceId, request) => shots.handle(workspaceId, request),
    put: async (sessionId, audio, upload) => {
      puts.push({ sessionId, audio, upload });
      const note = [...shots.notes.values()].find((item) =>
        upload.url.includes(`/${item.id}/`),
      );
      note.runs.get("0").stored = true;
      return 200;
    },
    audio: async () => ({
      contentType: "audio/wav",
      bytes: 128_044,
      sha256: "a".repeat(64),
      relativePath: "audio.wav",
    }),
    transcriptionRunning: () => false,
    transcribe: async (sessionId) => {
      transcribed.push(sessionId);
      local.set(sessionId, {
        source: "on_device",
        sourceIds: [`t-${sessionId}`],
        versionKey: `t-${sessionId}:v1`,
        engine: "apple_speech/apple-speech-analyzer",
      });
      return {
        transcriptId: `t-${sessionId}`,
        text: "Shots, post this at ten tomorrow.",
        engine: "apple-speech-analyzer",
        locale: "en-US",
        segments: [
          {
            startMs: 0,
            endMs: 2000,
            text: "Shots, post this at ten tomorrow.",
          },
        ],
      };
    },
    transcriptVersion: async (sessionId, ids) => {
      const version = local.get(sessionId);
      return version && (!ids || ids.join(",") === version.sourceIds.join(","))
        ? version
        : null;
    },
    transcriptText: async () => "Provider transcript.",
    deletedSessions: async () => new Set(),
    notes: () => notes,
    save: async (note) => {
      notes = notes.some((item) => item.sessionId === note.sessionId)
        ? notes.map((item) => (item.sessionId === note.sessionId ? note : item))
        : [...notes, note];
    },
    remove: async (sessionId) => {
      notes = notes.filter((item) => item.sessionId !== sessionId);
    },
    appVersion: "0.1.9",
    uploadAudio: true,
    now: () => clock.now,
    ...overrides,
  };
  return {
    deps,
    shots,
    clock,
    puts,
    local,
    transcribed,
    notes: () => notes,
    note: (id) => notes.find((item) => item.sessionId === id),
  };
}

const recording = (sessionId, patch = {}) => ({
  ...newVoiceNote({
    sessionId,
    recordedAt: "2026-11-11T04:50:00.000Z",
    recordedTimeZone: "America/New_York",
    locale: "en",
    durationMs: 4_000,
    audioUploadConsent: true,
  }),
  ...patch,
});

test("a lost create response is replayed into one note, then the transcript and audio follow once", async () => {
  const { deps, shots, clock, puts, note } = harness({
    queued: [recording("s1")],
  });
  let lost = true;
  const request = deps.request;
  deps.request = async (workspaceId, call) => {
    const response = await request(workspaceId, call);
    if (call.suffix === "notes" && lost) {
      lost = false;
      throw new TypeError("Network request failed");
    }
    return response;
  };

  assert.equal((await runVoicePass(deps)).status, "offline");
  assert.equal(note("s1").remoteId, null);
  assert.equal(note("s1").nextAttemptAt, clock.now + 30_000);

  clock.now += 30_000;
  assert.equal((await runVoicePass(deps)).status, "idle");
  assert.equal(shots.notes.size, 1);
  const stored = shots.notes.get("s1");
  assert.equal(stored.body.recordedTimeZone, "America/New_York");
  assert.equal(stored.body.audioUploadConsent, true);
  assert.deepEqual(
    [...stored.revisions.values()].map((revision) => revision.origin),
    ["on_device"],
  );
  assert.equal(stored.runs.get("0").status, "available");
  assert.equal(puts.length, 1);
  assert.equal(note("s1").audio, "done");
  assert.ok(shots.requests.every((call) => call.workspaceId === "workspace-1"));

  const before = shots.requests.length;
  await runVoicePass(deps);
  assert.deepEqual(
    shots.requests.slice(before).map((call) => `${call.method} ${call.suffix}`),
    ["GET settings", "GET notes/index"],
  );
});

test("a transcript resent after a server error keeps its client revision id", async () => {
  const shots = fakeShots();
  let failures = 1;
  shots.override = (method, suffix) =>
    suffix.endsWith("/transcripts") && failures-- > 0
      ? { status: 503, body: null }
      : undefined;
  const { deps, clock } = harness({ shots, queued: [recording("s1")] });
  assert.equal((await runVoicePass(deps)).status, "offline");
  clock.now += 30_000;
  await runVoicePass(deps);
  const ids = shots.requests
    .filter((call) => call.suffix.endsWith("/transcripts"))
    .map((call) => call.body.clientRevisionId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(shots.notes.get("s1").revisions.size, 1);
});

test("a note deleted in Shots stops syncing and the phone keeps its own note", async () => {
  const shots = fakeShots();
  const { deps, note, notes } = harness({
    shots,
    queued: [recording("s1", { onDevice: "done" })],
  });
  deps.transcriptVersion = async () => null;
  await runVoicePass(deps);
  shots.notes.get("s1").deleted = true;

  deps.transcriptVersion = async () => ({
    sourceIds: ["t9"],
    versionKey: "t9:v1",
    engine: "deepgram",
  });
  await runVoicePass(deps);
  assert.equal(note("s1").deletedRemote, true);
  assert.equal(notes().length, 1);

  const before = shots.requests.length;
  await runVoicePass(deps);
  assert.ok(
    shots.requests
      .slice(before)
      .every((call) => !call.suffix.startsWith("notes/note-")),
  );
});

test("a tombstone in the index marks the note deleted in Shots", async () => {
  const { deps, shots, note } = harness({ queued: [recording("s1")] });
  await runVoicePass(deps);
  shots.notes.get("s1").deleted = true;
  await runVoicePass(deps);
  assert.equal(note("s1").deletedRemote, true);
});

test("403 blocks the workspace queue with an explanation and sends nothing", async () => {
  const shots = fakeShots();
  shots.override = (method, suffix) =>
    suffix === "settings"
      ? {
          status: 403,
          body: { message: "You are not a member of this workspace." },
        }
      : undefined;
  const { deps, notes } = harness({ shots, queued: [recording("s1")] });
  const result = await runVoicePass(deps);
  assert.equal(result.status, "blocked");
  assert.equal(result.message, "You are not a member of this workspace.");
  assert.equal(shots.requests.length, 1);
  assert.equal(notes()[0].remoteId, null);
});

test("401 keeps the queue untouched and the next pass after sign-in resumes", async () => {
  const shots = fakeShots();
  shots.override = (method, suffix) =>
    suffix === "notes" ? { status: 401, body: null } : undefined;
  const { deps, note } = harness({ shots, queued: [recording("s1")] });
  assert.equal((await runVoicePass(deps)).status, "signed_out");
  assert.equal(note("s1").attempts, 0);
  assert.equal(note("s1").failed, null);
  shots.override = undefined;
  assert.equal((await runVoicePass(deps)).status, "idle");
  assert.ok(note("s1").remoteId);
});

test("nothing is sent when the queue's account or workspace is not the active one", async () => {
  for (const isActive of [
    (accountId) => accountId === "account-b",
    (accountId, workspaceId) => workspaceId === "workspace-2",
  ]) {
    const { deps, shots, notes } = harness({
      queued: [recording("s1")],
      isActive,
    });
    assert.equal((await runVoicePass(deps)).status, "inactive");
    assert.equal(shots.requests.length, 0);
    assert.equal(notes()[0].createSent, false);
  }
});

test("a newer minimum app version stops sync before any note is sent", async () => {
  const shots = fakeShots();
  shots.settings = settings({ minAppVersion: "1.0.0" });
  const { deps } = harness({ shots, queued: [recording("s1")] });
  const result = await runVoicePass(deps);
  assert.equal(result.status, "update_required");
  assert.deepEqual(
    shots.requests.map((call) => call.suffix),
    ["settings"],
  );
});

test("without an on-device engine the note syncs untranscribed, then sends the provider transcript as remote", async () => {
  const { deps, shots } = harness({
    queued: [recording("s1", { audioUploadConsent: false })],
  });
  deps.transcribe = async () => null;
  deps.transcriptVersion = async () => null;
  await runVoicePass(deps);
  assert.equal(shots.notes.get("s1").revisions.size, 0);

  deps.transcriptVersion = async (sessionId, ids) =>
    ids
      ? null
      : { sourceIds: ["live-1"], versionKey: "live-1:v1", engine: "deepgram" };
  await runVoicePass(deps);
  const [revision] = shots.notes.get("s1").revisions.values();
  assert.equal(revision.origin, "remote");
  assert.equal(revision.text, "Provider transcript.");
  assert.equal(revision.engine, "deepgram");
});

test("on-device failures are retried, then the note syncs without them", async () => {
  const { deps, clock, note } = harness({
    queued: [recording("s1", { audioUploadConsent: false })],
  });
  deps.transcribe = async () => {
    throw new Error("not implemented");
  };
  deps.transcriptVersion = async () => null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await runVoicePass(deps);
    clock.now += 60 * 60 * 1000;
  }
  assert.equal(note("s1").onDevice, "done");
  assert.ok(note("s1").remoteId);
});

test("an edit of a sent transcript becomes a user_edit revision with its parent", async () => {
  const { deps, shots } = harness({
    queued: [recording("s1", { audioUploadConsent: false })],
  });
  await runVoicePass(deps);
  deps.transcriptVersion = async (sessionId, ids) => ({
    sourceIds: ids,
    versionKey: `${ids.join(",")}:v2`,
    engine: null,
  });
  deps.transcriptText = async () => "Edited transcript.";
  await runVoicePass(deps);
  const [first, edit] = shots.notes.get("s1").revisions.values();
  assert.equal(first.origin, "on_device");
  assert.equal(edit.origin, "user_edit");
  assert.equal(edit.parentId, "rev-1");
  assert.equal(edit.text, "Edited transcript.");
});

test("deleting a sent note on the phone deletes it in Shots and forgets it", async () => {
  const { deps, shots, notes } = harness({ queued: [recording("s1")] });
  await runVoicePass(deps);
  deps.deletedSessions = async (ids) => new Set(ids);
  await runVoicePass(deps);
  assert.equal(shots.notes.get("s1").deleted, true);
  assert.equal(notes().length, 0);
});

test("an interrupted run is sent whole again, an expired URL is replaced, and a run the server could not verify is resent", async () => {
  const shots = fakeShots();
  const { deps, clock, puts, note } = harness({
    shots,
    queued: [recording("s1")],
  });
  deps.put = async (sessionId, audio, upload) => {
    puts.push(upload.expiresAt);
    // First PUT: connection lost (S2). Second: stored truncated, so complete answers 400 (S4).
    if (puts.length === 1) throw new TypeError("Network request failed");
    if (puts.length === 3) shots.notes.get("s1").runs.get("0").stored = true;
    return 200;
  };
  assert.equal((await runVoicePass(deps)).status, "offline");
  assert.ok(note("s1").upload);

  clock.now += 30 * 60_000;
  await runVoicePass(deps);
  assert.equal(note("s1").audio, "todo");
  assert.equal(note("s1").upload, null);

  clock.now += 30 * 60_000;
  await runVoicePass(deps);
  assert.equal(note("s1").audio, "done");
  assert.equal(puts.length, 3);
  // Each PUT used a URL that was still valid (S3).
  assert.equal(new Set(puts).size, 3);
  assert.equal(
    shots.requests.filter((call) => call.suffix.endsWith("/upload")).length,
    3,
  );
});

test("audio refused at complete stops the audio only; the note stays sent", async () => {
  const shots = fakeShots();
  shots.override = (method, suffix) =>
    suffix.endsWith("/complete")
      ? {
          status: 403,
          body: { message: "Voice audio upload is off in this workspace." },
        }
      : undefined;
  const { deps, note } = harness({ shots, queued: [recording("s1")] });
  assert.equal((await runVoicePass(deps)).status, "idle");
  assert.equal(note("s1").audio, "unavailable");
  assert.equal(note("s1").blocked, null);
  assert.ok(note("s1").remoteId);
});

test("a note with the user's own transcript sends it and never transcribes on device", async () => {
  for (const [source, origin] of [
    ["provider", "remote"],
    ["on_device", "on_device"],
  ]) {
    const { deps, shots, local, transcribed, note } = harness({
      queued: [recording("s1", { audioUploadConsent: false })],
    });
    local.set("s1", {
      source,
      sourceIds: ["live-1"],
      versionKey: "live-1:v3",
      engine: "anarlog/live",
    });
    assert.equal((await runVoicePass(deps)).status, "idle");
    assert.deepEqual(transcribed, []);
    const [revision] = shots.notes.get("s1").revisions.values();
    assert.equal(revision.origin, origin);
    assert.equal(revision.text, "Provider transcript.");
    assert.equal(note("s1").onDevice, "done");
    assert.deepEqual(note("s1").sent.sourceIds, ["live-1"]);
  }
});

test("a note whose transcription is still running waits for it instead of transcribing on device", async () => {
  const { deps, shots, clock, local, transcribed, note } = harness({
    queued: [recording("s1", { audioUploadConsent: false })],
  });
  let running = true;
  deps.transcriptionRunning = (sessionId) => running && sessionId === "s1";
  await runVoicePass(deps);
  assert.deepEqual(transcribed, []);
  assert.equal(shots.notes.get("s1").revisions.size, 0);
  assert.equal(note("s1").onDevice, "todo");
  assert.equal(note("s1").nextAttemptAt, clock.now + 30_000);

  clock.now += 30_000;
  await runVoicePass(deps);
  assert.deepEqual(transcribed, []);
  assert.equal(note("s1").nextAttemptAt, clock.now + 60_000);

  running = false;
  local.set("s1", {
    source: "provider",
    sourceIds: ["batch-1"],
    versionKey: "batch-1:v1",
    engine: "deepgram/nova-3",
  });
  clock.now += 60_000;
  await runVoicePass(deps);
  assert.deepEqual(transcribed, []);
  const [revision] = shots.notes.get("s1").revisions.values();
  assert.equal(revision.origin, "remote");
  assert.equal(note("s1").attempts, 0);
});

test("when the sent transcript rows are replaced, the session's new transcript is sent", async () => {
  const { deps, shots, local } = harness({
    queued: [recording("s1", { audioUploadConsent: false })],
  });
  await runVoicePass(deps);
  local.set("s1", {
    source: "provider",
    sourceIds: ["batch-2"],
    versionKey: "batch-2:v1",
    engine: "deepgram/nova-3",
  });
  await runVoicePass(deps);
  const [first, replaced] = shots.notes.get("s1").revisions.values();
  assert.equal(first.origin, "on_device");
  assert.equal(replaced.origin, "remote");
  assert.equal(replaced.parentId, "rev-1");
});

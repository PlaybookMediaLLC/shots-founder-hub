import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

// The runner against the canonical schema in SQLite and an in-memory Shots.
const root = new URL("../", import.meta.url);
const fixture = (globalThis.shotsVoiceRunnerFixture = {
  db: null,
  storage: new Map(),
  running: new Set(),
  onDevice: [],
  onDeviceResult: null,
  requests: [],
  errors: [],
  shots: null,
});
const mocks = {
  "expo-constants": `export default { expoConfig: { version: "0.1.9" } };`,
  "expo-file-system": `export const Paths = { document: "file:///documents" }; export class File {}`,
  "@react-native-async-storage/async-storage": `const f = globalThis.shotsVoiceRunnerFixture;
    export default {
      async getItem(key) { return f.storage.get(key) ?? null; },
      async setItem(key, value) { f.storage.set(key, value); },
    };`,
  "@anlg/mobile-bridge": `export function renderStoredTranscript(input) {
    const row = JSON.parse(input);
    const text = JSON.parse(row.words_json).map((word) => word.text).join(" ");
    return JSON.stringify([{ id: row.id, text, speaker: "", startMs: 0, wordCount: 0 }]);
  }`,
  "@/auth/client": `export const supabase = { auth: { async getSession() {
    return { data: { session: { user: { id: "account-a" }, access_token: "token" } } };
  } } };`,
  "@/db": `const f = globalThis.shotsVoiceRunnerFixture;
    export function useLiveQuery() {}
    export async function execute(sql, params = []) { return f.db.prepare(sql).all(...params); }`,
  "@/lib/env": `export const env = { apiUrl: "https://api.test", shotsUrl: "https://shots.test" };`,
  "@/lib/error-reporting": `export function captureOperationalError(error) { globalThis.shotsVoiceRunnerFixture.errors.push(error); }`,
  "@/settings/preferences": `export async function readPreferences() { return { ai_language: "en" }; }`,
  "@/data/audio-catalog": `export const deviceTimeZone = () => "Europe/Paris";`,
  "@/data/transcribe": `export const isTranscriptionRunning = (id) => globalThis.shotsVoiceRunnerFixture.running.has(id);`,
  "@/data/on-device-transcription": `export async function transcribeSessionOnDevice(id) {
    const f = globalThis.shotsVoiceRunnerFixture; f.onDevice.push(id); return f.onDeviceResult;
  }`,
  "./api": `export async function voiceFetch({ workspaceId, request }) {
    return globalThis.shotsVoiceRunnerFixture.shots(workspaceId, request);
  }`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (mocks[specifier])
      return {
        url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`,
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return {
        url: new URL(`${specifier.slice(2)}.ts`, root).href,
        shortCircuit: true,
      };
    if (specifier.startsWith(".") && context.parentURL?.startsWith(root.href)) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { queueSessionForShots, stopShotsVoiceSync } =
  await import("./runner.ts");
const { activateShotsVoice, getShotsVoice, setShotsVoicePrefs } =
  await import("./store.ts");

const settings = {
  workspace: { voiceNotes: true, audioUpload: false, voiceCommands: false },
  member: { remoteTextConsentAt: null, voiceCommands: false },
  minAppVersion: "0.1.0",
  limits: {
    maxNoteMs: 1_800_000,
    warnAtMs: 1_500_000,
    minNoteMs: 1_000,
    maxTranscriptChars: 100_000,
    maxCommandChars: 2_000,
  },
  switches: { notes: true, audioUpload: false, parse: true },
};

beforeEach(async () => {
  fixture.db?.close();
  fixture.db = new DatabaseSync(":memory:");
  for (const migration of [
    "20260710223922_canonical_data_model.sql",
    "20260717140000_attachment_local_state.sql",
  ])
    fixture.db.exec(
      readFileSync(
        new URL(
          `../../../../crates/db-app/migrations/${migration}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  fixture.db.exec(`
    ALTER TABLE transcripts ADD COLUMN content_version TEXT NOT NULL DEFAULT '';
    CREATE TABLE transcript_live_deltas (transcript_id TEXT, sequence INTEGER, delta_json TEXT);
    INSERT INTO sessions (id, workspace_id, owner_user_id, created_at)
      VALUES ('note', 'library', 'account-a', '2026-11-11T09:00:00.000Z');
    INSERT INTO session_attachments (id, workspace_id, session_id, filename, source_type, source_id, metadata_json)
      VALUES ('session-audio:note', 'library', 'note', 'audio.wav', 'session_audio', 'primary',
        json_object('transcript_status', 'complete'));
    INSERT INTO attachment_local_state (attachment_id, session_id, relative_path)
      VALUES ('session-audio:note', 'note', 'audio.wav');
  `);
  fixture.running.clear();
  fixture.onDevice = [];
  fixture.onDeviceResult = null;
  fixture.requests = [];
  fixture.errors = [];
  fixture.storage.clear();
  fixture.shots = (workspaceId, { method, suffix, body }) => {
    fixture.requests.push({ workspaceId, method, suffix, body });
    if (suffix === "settings") return { status: 200, body: settings };
    if (suffix === "notes/index") return { status: 200, body: { notes: [] } };
    const note = { id: "n1", clientNoteId: "note", deleted: false };
    if (method === "POST" && suffix === "notes")
      return { status: 201, body: { ...note, revision: 1, command: null } };
    if (method === "POST" && suffix === "notes/n1/transcripts")
      return {
        status: 200,
        body: {
          revision: { id: "rev-1" },
          note: { ...note, revision: 2 },
          command: null,
        },
      };
    return { status: 400, body: null };
  };
  await activateShotsVoice(null);
  await activateShotsVoice("account-a");
  await setShotsVoicePrefs({ workspaceId: "ws-1", workspaceName: "Team" });
});

/** Queues the note explicitly and waits for the pass that sends it. */
async function sendToShots(sessionId = "note") {
  const before = getShotsVoice().status;
  assert.equal(
    await queueSessionForShots(sessionId, { explicit: true }),
    "queued",
  );
  for (let turn = 0; getShotsVoice().status === before; turn += 1) {
    assert.ok(turn < 10_000, "the pass did not finish");
    await new Promise((resolve) => setImmediate(resolve));
  }
  stopShotsVoiceSync();
  return getShotsVoice().notes.find((note) => note.sessionId === sessionId);
}

const transcriptRequests = () =>
  fixture.requests.filter((call) => call.suffix.endsWith("/transcripts"));
const transcriptRows = () =>
  fixture.db
    .prepare("SELECT id, words_json, deleted_at FROM transcripts ORDER BY id")
    .all()
    .map((row) => ({ ...row }));

test("a live transcript is sent as remote and left alone, with no on-device run", async () => {
  fixture.db
    .exec(`INSERT INTO transcripts (id, session_id, source, provider, model, content_version, words_json)
    VALUES ('live', 'note', 'live_capture', 'anarlog', 'cloud', 'v1', '[{"text":"Ship"},{"text":"Friday"}]')`);
  const rows = transcriptRows();
  const note = await sendToShots();
  assert.deepEqual(fixture.onDevice, []);
  const [call] = transcriptRequests();
  assert.equal(call.body.origin, "remote");
  assert.equal(call.body.text, "Ship Friday");
  assert.equal(call.body.engine, "anarlog/cloud");
  assert.deepEqual(note.sent, {
    id: "rev-1",
    sourceIds: ["live"],
    versionKey: "live:v1",
  });
  assert.deepEqual(transcriptRows(), rows);
});

test("an edited Apple transcript is sent as on_device and left alone", async () => {
  fixture.db
    .exec(`INSERT INTO transcripts (id, session_id, source, provider, model, content_version, words_json)
    VALUES ('apple', 'note', 'batch_transcription', 'apple_speech', 'apple-speech-analyzer', 'edited', '[{"text":"Edited"}]')`);
  const rows = transcriptRows();
  await sendToShots();
  assert.deepEqual(fixture.onDevice, []);
  assert.equal(transcriptRequests()[0].body.origin, "on_device");
  assert.equal(transcriptRequests()[0].body.text, "Edited");
  assert.deepEqual(transcriptRows(), rows);
});

test("a running transcription is waited for, not raced on device", async () => {
  fixture.db.exec(
    "UPDATE session_attachments SET metadata_json = json_object('transcript_status', 'processing')",
  );
  fixture.running.add("note");
  const note = await sendToShots();
  assert.deepEqual(fixture.onDevice, []);
  assert.deepEqual(transcriptRequests(), []);
  assert.equal(note.onDevice, "todo");
  assert.ok(note.nextAttemptAt > Date.now());
});

test("the rows of an unfinished transcription are never replaced on device", async () => {
  fixture.db.exec(`
    UPDATE session_attachments SET metadata_json = json_object('transcript_status', 'processing');
    INSERT INTO transcripts (id, session_id, source, provider, content_version, words_json)
      VALUES ('partial', 'note', 'live_capture', 'anarlog', 'v1', '[{"text":"Half"}]');
  `);
  const rows = transcriptRows();
  const note = await sendToShots();
  assert.deepEqual(fixture.onDevice, []);
  assert.deepEqual(transcriptRequests(), []);
  assert.equal(note.onDevice, "done");
  assert.deepEqual(transcriptRows(), rows);
});

test("a note with no transcript and nothing running is transcribed on device", async () => {
  fixture.db.exec(
    "UPDATE session_attachments SET metadata_json = json_object('transcript_status', 'processing')",
  );
  fixture.onDeviceResult = {
    transcriptId: "on-device",
    text: "Shots, post this.",
    engine: "apple-speech-analyzer",
    locale: "en-US",
    segments: [{ startMs: 0, endMs: 900, text: "Shots, post this." }],
  };
  await sendToShots();
  assert.deepEqual(fixture.onDevice, ["note"]);
  assert.equal(transcriptRequests()[0].body.origin, "on_device");
  assert.equal(transcriptRequests()[0].body.text, "Shots, post this.");
});

test("a transcript row that cannot be read is left out of the text sent", async () => {
  fixture.db
    .exec(`INSERT INTO transcripts (id, session_id, source, provider, content_version, started_at_ms, words_json)
    VALUES ('broken', 'note', 'live_capture', 'anarlog', 'v1', 1, '[{"text":'),
      ('good', 'note', 'batch_transcription', 'deepgram', 'v1', 2, '[{"text":"Readable"}]')`);
  await sendToShots();
  assert.equal(transcriptRequests()[0].body.text, "Readable");
  assert.equal(fixture.errors.length, 1);
});

test("a stored queue with malformed notes loads the readable ones", async () => {
  fixture.storage.set(
    "anarlog:shots-voice:account-a:ws-1",
    JSON.stringify({
      notes: [
        { sessionId: "kept", remoteId: "n1", sent: "garbage", attempts: "x" },
        { remoteId: "no-session" },
        "text",
      ],
    }),
  );
  await activateShotsVoice("account-a");
  const [note, ...rest] = getShotsVoice().notes;
  assert.deepEqual(rest, []);
  assert.equal(note.sessionId, "kept");
  assert.equal(note.remoteId, "n1");
  assert.equal(note.sent, null);
  assert.equal(note.attempts, 0);
});

test("a note carries the time zone it was recorded in, or the phone's when that is unknown", async () => {
  fixture.db.exec(`
    UPDATE sessions SET metadata_json = json_object('mobile_capture_started_at_ms', 1794390000000, 'mobile_capture_time_zone', 'Asia/Tokyo');
    INSERT INTO sessions (id, owner_user_id) VALUES ('imported', 'account-a');
  `);
  const recorded = await sendToShots();
  assert.equal(recorded.recordedTimeZone, "Asia/Tokyo");
  assert.equal(recorded.recordedAt, new Date(1794390000000).toISOString());
  const create = fixture.requests.find((call) => call.suffix === "notes");
  assert.equal(create.body.recordedTimeZone, "Asia/Tokyo");
  assert.equal(
    (await sendToShots("imported")).recordedTimeZone,
    "Europe/Paris",
  );
});

test("only this account's recordings are queued for Shots", async () => {
  fixture.db.exec(`
    INSERT INTO sessions (id, owner_user_id) VALUES ('theirs', 'account-b'), ('synced', 'library-1');
    INSERT INTO app_settings (id, value_json) VALUES ('cloudsync_workspace_binding', json_object('workspace_id', 'library-1'));
  `);
  assert.equal(
    await queueSessionForShots("theirs", { explicit: true }),
    "other_account",
  );
  assert.deepEqual(getShotsVoice().notes, []);
  const synced = await sendToShots("synced");
  assert.equal(synced.sessionId, "synced");
  assert.deepEqual(
    getShotsVoice().notes.map((note) => note.sessionId),
    ["synced"],
  );
});

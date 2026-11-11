import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

const root = new URL("../", import.meta.url);
const fixture = (globalThis.onDeviceTranscriptionFixture = {
  db: null,
  native: null,
  calls: [],
  summaries: [],
});
const mocks = {
  "../../modules/on-device-speech": `const f = globalThis.onDeviceTranscriptionFixture;
    export default {
      async getCapability(locale) { f.calls.push(['getCapability', locale]); return f.native.capability; },
      async requestPermission() { f.calls.push(['requestPermission']); return f.native.requested; },
      async transcribeFile(...args) { f.calls.push(['transcribeFile', ...args]); return f.native.result; },
    };`,
  "expo-file-system": `export const Paths = {document: 'file:///documents'};
    export class File { constructor(...parts) { this.uri = parts.join('/'); this.exists = true; } }`,
  "@/db": `const f = globalThis.onDeviceTranscriptionFixture;
    export async function execute(sql, params = []) { return f.db.prepare(sql).all(...params); }
    export async function executeTransaction(statements) {
      f.db.exec('BEGIN');
      try { const changes = statements.map(({sql, params}) => f.db.prepare(sql).run(...params).changes); f.db.exec('COMMIT'); return changes; }
      catch (error) { f.db.exec('ROLLBACK'); throw error; }
    }`,
  "@/lib/ids": `import {randomUUID} from 'node:crypto'; export const id = randomUUID; export const nowIso = () => new Date().toISOString();`,
  "@/settings/preferences": `export async function readPreferences() {
    return {ai_language: 'en', spoken_languages: [], personalization_dictionary_terms: ['Anarlog']};
  }`,
  "./summarize": `export function generateSummaryAfterTranscription(sessionId) { globalThis.onDeviceTranscriptionFixture.summaries.push(sessionId); }`,
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

const { transcribeSessionOnDevice } =
  await import("./on-device-transcription.ts");

const captureStartedAt = 1730000000000;

beforeEach(() => {
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
    INSERT INTO sessions (id, workspace_id, owner_user_id) VALUES ('note', 'workspace', 'owner');
    INSERT INTO session_attachments (id, workspace_id, session_id, filename, source_type, source_id, metadata_json)
      VALUES ('session-audio:note', 'workspace', 'note', 'audio.wav', 'session_audio', 'primary',
        json_object('transcript_status', 'complete', 'capture_started_at_ms', ${captureStartedAt}));
    INSERT INTO attachment_local_state (attachment_id, session_id, relative_path) VALUES ('session-audio:note', 'note', 'audio.wav');
    INSERT INTO transcripts (id, session_id, source, provider, words_json) VALUES ('earlier', 'note', 'live_capture', 'anarlog', '[]');
  `);
  fixture.calls = [];
  fixture.summaries = [];
  fixture.native = {
    capability: { engine: "sf_speech_on_device", permission: "granted" },
    requested: "granted",
    result: {
      text: "Ship it on Friday. Then tell the team.",
      engine: "sf_speech_on_device",
      locale: "en-US",
      segments: [
        {
          startMs: 400,
          endMs: 1600,
          text: " Ship it on Friday. ",
          approximate: true,
        },
        { startMs: 60000, endMs: 60000, text: "   " },
        { startMs: 60250.4, endMs: 61450, text: "Then tell the team." },
      ],
    },
  };
});

const liveTranscripts = () =>
  fixture.db
    .prepare("SELECT * FROM transcripts WHERE deleted_at IS NULL")
    .all();

test("replaces the session's transcripts with a canonical on-device batch transcript", async () => {
  const result = await transcribeSessionOnDevice("note", {
    locale: "en-GB",
    vocabulary: ["Shots"],
  });

  assert.deepEqual(fixture.calls.at(-1), [
    "transcribeFile",
    "file:///documents/sessions/note/audio.wav",
    "en-GB",
    ["Shots"],
  ]);
  const [row] = liveTranscripts();
  assert.equal(liveTranscripts().length, 1);
  assert.equal(row.id, result.transcriptId);
  assert.equal(row.source, "batch_transcription");
  assert.equal(row.provider, "apple_speech");
  assert.equal(row.model, "apple-sf-speech-on-device");
  assert.equal(row.language, "en-US");
  assert.equal(row.started_at_ms, captureStartedAt);
  assert.equal(row.owner_user_id, "owner");
  assert.equal(row.workspace_id, "workspace");
  assert.deepEqual(
    JSON.parse(row.words_json).map(({ text, start_ms, end_ms, channel }) => [
      text,
      start_ms,
      end_ms,
      channel,
    ]),
    [
      ["Ship", 400, 700, 0],
      ["it", 700, 1000, 0],
      ["on", 1000, 1300, 0],
      ["Friday.", 1300, 1600, 0],
      ["Then", 60250, 60550, 0],
      ["tell", 60550, 60850, 0],
      ["the", 60850, 61150, 0],
      ["team.", 61150, 61450, 0],
    ],
  );
  assert.equal(
    fixture.db
      .prepare(
        "SELECT json_extract(metadata_json, '$.transcript_status') AS status FROM session_attachments",
      )
      .get().status,
    "complete",
  );
  assert.ok(
    fixture.db
      .prepare("SELECT 1 FROM app_settings WHERE id = ?")
      .get("mobile_auto_summary_pending:note"),
  );
  assert.deepEqual(fixture.summaries, ["note"]);
  assert.deepEqual(result, {
    transcriptId: row.id,
    text: "Ship it on Friday. Then tell the team.",
    engine: "apple-sf-speech-on-device",
    locale: "en-US",
    segments: [
      {
        startMs: 400,
        endMs: 1600,
        text: "Ship it on Friday.",
        approximate: true,
      },
      { startMs: 60250, endMs: 61450, text: "Then tell the team." },
    ],
  });
});

test("defaults to the app's language and dictionary and asks for permission only once undetermined", async () => {
  fixture.native.capability = {
    engine: "speech_analyzer",
    permission: "undetermined",
  };
  fixture.native.result.engine = "speech_analyzer";
  const result = await transcribeSessionOnDevice("note");
  assert.deepEqual(
    fixture.calls.map(([name, ...args]) =>
      name === "transcribeFile" ? [name, args[1], args[2]] : [name, ...args],
    ),
    [
      ["getCapability", "en"],
      ["requestPermission"],
      ["transcribeFile", "en", ["Anarlog"]],
    ],
  );
  assert.equal(result.engine, "apple-speech-analyzer");
  assert.equal(liveTranscripts()[0].model, "apple-speech-analyzer");
});

test("leaves the note playable without a transcript when nothing can be transcribed on device", async () => {
  const cases = [
    () => {
      fixture.native.capability = { engine: "none", permission: "granted" };
    },
    () => {
      fixture.native.capability.permission = "undetermined";
      fixture.native.requested = "denied";
    },
    () => {
      fixture.native.capability.permission = "restricted";
    },
    () => {
      fixture.native.result.segments = [{ startMs: 0, endMs: 900, text: " " }];
    },
  ];
  for (const arrange of cases) {
    fixture.native.capability = {
      engine: "sf_speech_on_device",
      permission: "granted",
    };
    fixture.native.requested = "granted";
    arrange();
    assert.equal(await transcribeSessionOnDevice("note"), null);
    assert.deepEqual(
      liveTranscripts().map(({ id }) => id),
      ["earlier"],
    );
  }
  // Only the silent recording reached the recognizer.
  assert.equal(
    fixture.calls.filter(([name]) => name === "transcribeFile").length,
    1,
  );
  assert.deepEqual(fixture.summaries, []);
});

test("a recording missing from this device fails instead of returning an empty note", async () => {
  fixture.db.exec("UPDATE attachment_local_state SET availability = 'absent'");
  await assert.rejects(transcribeSessionOnDevice("note"), {
    code: "audio_missing",
  });
  assert.deepEqual(fixture.calls, []);
});

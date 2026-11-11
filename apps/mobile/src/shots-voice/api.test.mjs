import assert from "node:assert/strict";
import test from "node:test";

import { voiceFetch } from "./api.ts";

test("voice calls go to the gateway's Shots voice path with the session and the queue's workspace", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? new Response(JSON.stringify({ id: "note-1" }), { status: 201 })
      : new Response(null, { status: 204 });
  };
  const created = await voiceFetch({
    apiUrl: "https://api.example.test/",
    accessToken: "shots-access",
    workspaceId: "org-1",
    request: { method: "POST", suffix: "notes", body: { clientNoteId: "s1" } },
    fetch,
  });
  assert.deepEqual(created, { status: 201, body: { id: "note-1" } });
  assert.equal(calls[0].url, "https://api.example.test/cloud/voice/notes");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer shots-access");
  assert.equal(calls[0].init.headers["X-Shots-Organization-Id"], "org-1");
  assert.equal(calls[0].init.body, JSON.stringify({ clientNoteId: "s1" }));

  const deleted = await voiceFetch({
    apiUrl: "https://api.example.test",
    accessToken: "shots-access",
    workspaceId: "org-1",
    request: { method: "DELETE", suffix: "notes/a b" },
    fetch,
  });
  assert.deepEqual(deleted, { status: 204, body: null });
  assert.equal(
    calls[1].url,
    "https://api.example.test/cloud/voice/notes/a%20b",
  );
  assert.equal(calls[1].init.body, undefined);
});

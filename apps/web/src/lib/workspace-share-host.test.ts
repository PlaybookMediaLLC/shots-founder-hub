import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkspaceShareSlug,
  isWorkspaceShareHostname,
} from "./workspace-share-host.ts";

test("accepts one valid enterprise workspace subdomain", () => {
  assert.equal(
    isWorkspaceShareHostname("fastrepl.shots.playbookmedia.io"),
    true,
  );
  assert.equal(
    isWorkspaceShareHostname("fastrepl-hq.shots.playbookmedia.io"),
    true,
  );
  assert.equal(
    getWorkspaceShareSlug("fastrepl.shots.playbookmedia.io"),
    "fastrepl",
  );
});

test("rejects reserved, nested, and malformed workspace hosts", () => {
  assert.equal(isWorkspaceShareHostname("api.shots.playbookmedia.io"), false);
  assert.equal(
    isWorkspaceShareHostname("desktop.shots.playbookmedia.io"),
    false,
  );
  assert.equal(
    isWorkspaceShareHostname("models.shots.playbookmedia.io"),
    false,
  );
  assert.equal(isWorkspaceShareHostname("www.shots.playbookmedia.io"), false);
  assert.equal(isWorkspaceShareHostname("a.b.shots.playbookmedia.io"), false);
  assert.equal(
    isWorkspaceShareHostname("-fastrepl.shots.playbookmedia.io"),
    false,
  );
  assert.equal(isWorkspaceShareHostname("fastrepl.example.com"), false);
  assert.equal(getWorkspaceShareSlug("www.shots.playbookmedia.io"), null);
});

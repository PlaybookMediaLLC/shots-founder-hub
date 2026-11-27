import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const provisionScript = join(root, "scripts/gcp/provision-gcp-runner.sh");
const verifyScript = join(root, "scripts/gcp/verify-gcp-runner.sh");

test("provision-gcp-runner rejects missing or invalid --env", () => {
  for (const args of [
    [],
    ["--env", "staging"],
    ["--env", "prod", "--project", "INVALID_ID"],
  ]) {
    const result = spawnSync("bash", [provisionScript, ...args], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `expected failure for args: ${args.join(" ")}`,
    );
  }
});

test("provision-gcp-runner --dry-run plans Track A + Track B for prod without Gmail API", () => {
  const result = spawnSync(
    "bash",
    [provisionScript, "--env", "prod", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = result.stdout;

  assert.match(out, /shots-founder-hub-prod/);
  assert.match(
    out,
    /--name=Shots\\ Founder\\ Hub\\ Prod|--name='Shots Founder Hub Prod'/,
  );
  assert.match(out, /calendar-json\.googleapis\.com/);
  assert.match(out, /drive\.googleapis\.com/);
  assert.match(out, /meet\.googleapis\.com/);
  assert.match(out, /iamcredentials\.googleapis\.com/);
  assert.match(out, /artifactregistry\.googleapis\.com/);
  assert.match(out, /github-actions-pool/);
  assert.match(out, /PlaybookMediaLLC\/shots-founder-hub/);
  assert.match(out, /PlaybookMediaLLC\/shots/);
  assert.match(out, /refs\/heads\/main/);
  assert.match(out, /environment:production/);
  assert.match(out, /sa-api-runtime/);
  assert.match(out, /shots-founder-hub-calendar/);
  assert.match(out, /shots-founder-hub-drive/);
  assert.match(out, /shots-founder-hub-meet/);
  assert.match(out, /https:\/\/shots\.playbookmedia\.io\/oauth\/callback/);
  assert.match(
    out,
    /https:\/\/shots\.playbookmedia\.io\/app\/google-drive-picker/,
  );
  assert.doesNotMatch(
    out,
    /gcloud services enable[^\n]*gmail\.googleapis\.com/,
  );
});

test("provision-gcp-runner --dry-run binds dev deployer to develop and localhost Drive redirect URIs", () => {
  const result = spawnSync(
    "bash",
    [provisionScript, "--env", "dev", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = result.stdout;

  assert.match(out, /shots-founder-hub-dev/);
  assert.match(out, /refs\/heads\/develop/);
  assert.match(out, /http:\/\/localhost:4400\/app\/google-drive-picker/);
  assert.match(out, /https:\/\/api\.nango\.dev\/oauth\/callback/);
});

test("verify-gcp-runner validates arguments and supports skipping both checks", () => {
  const invalid = spawnSync("bash", [verifyScript, "--env", "staging"], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);

  const skipped = spawnSync(
    "bash",
    [verifyScript, "--env", "prod", "--skip-gcp", "--skip-http"],
    { encoding: "utf8" },
  );
  assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout);
  assert.match(skipped.stdout, /All checked GCP Runner gates passed/);
});

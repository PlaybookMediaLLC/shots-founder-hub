import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("local setup preserves credentials and data ownership across reruns, including paths with shell syntax", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "founder-hub-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
  copyFileSync(
    join(root, "scripts/local-dev.mjs"),
    join(directory, "scripts/local-dev.mjs"),
  );
  const shots = join(directory, "shots $(literal) ' checkout");
  mkdirSync(join(shots, "server/cmd/platform-migrate"), { recursive: true });
  mkdirSync(join(shots, "clients/node_modules"), { recursive: true });
  writeFileSync(join(shots, "server/cmd/platform-migrate/main.go"), "");
  const invoke = (...args) =>
    spawnSync(
      process.execPath,
      [join(directory, "scripts/local-dev.mjs"), ...args],
      { cwd: tmpdir(), encoding: "utf8" },
    );
  for (const port of ["NaN", "65535", "80"]) {
    assert.equal(
      invoke("setup", "--shots-path", shots, "--port", port).status,
      1,
    );
  }
  const first = invoke("setup", "--shots-path", shots, "--port", "4300");
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const path = join(directory, ".local/founder-hub/config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.shotsPath, shots);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const credentials = [
    config.postgresPassword,
    config.serviceToken,
    config.authSecret,
    config.authorityToken,
    config.storageJwtSecret,
    config.restPassword,
    config.storagePassword,
    config.objectPassword,
    config.socialEncryptionKey,
    config.webhookEncryptionKey,
    config.auditEncryptionKey,
  ];
  assert.equal(new Set(credentials).size, credentials.length);
  for (const value of credentials) {
    assert.ok(value.length >= 64);
    assert.ok(!(first.stdout + first.stderr).includes(value));
  }
  const again = invoke("setup");
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  const legacy = { ...config };
  delete legacy.storageJwtSecret;
  delete legacy.restPassword;
  delete legacy.storagePassword;
  delete legacy.objectPassword;
  delete legacy.socialEncryptionKey;
  delete legacy.webhookEncryptionKey;
  delete legacy.auditEncryptionKey;
  writeFileSync(path, JSON.stringify(legacy));
  const upgraded = invoke("setup");
  assert.equal(upgraded.status, 0, upgraded.stderr + upgraded.stdout);
  const migrated = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(migrated.postgresPassword, config.postgresPassword);
  assert.equal(migrated.authorityToken, config.authorityToken);
  assert.equal(migrated.storageJwtSecret.length, 64);
  assert.equal(migrated.objectPassword.length, 64);
  assert.equal(migrated.socialEncryptionKey.length, 64);
  assert.equal(migrated.webhookEncryptionKey.length, 64);
  assert.equal(migrated.auditEncryptionKey.length, 64);
  const changed = invoke("setup", "--port", "4400");
  assert.equal(changed.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), migrated);
});

test("invalid commands and port ranges fail before provisioning local services", () => {
  for (const args of [
    ["destroy"],
    ["setup", "--shots-path", root, "--port", "NaN"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/local-dev.mjs"), ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
  }
});

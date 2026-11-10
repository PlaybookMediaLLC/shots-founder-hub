import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  mkdirSync(join(shots, "clients/apps/web"), { recursive: true });
  writeFileSync(join(shots, "server/cmd/platform-migrate/main.go"), "");
  writeFileSync(
    join(shots, "clients/apps/web/tsconfig.json"),
    '{"compilerOptions":{"strict":true}}',
  );
  const invokeWithEnv = (env, ...args) =>
    spawnSync(
      process.execPath,
      [join(directory, "scripts/local-dev.mjs"), ...args],
      { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, ...env } },
    );
  const invoke = (...args) => invokeWithEnv({}, ...args);
  for (const port of ["NaN", "65535", "80"]) {
    assert.equal(
      invoke("setup", "--shots-path", shots, "--port", port).status,
      1,
    );
  }
  const nangoEnv = {
    NANGO_API_KEY: "test-api-key",
    NANGO_API_BASE: "http://nango.example.test",
    NANGO_CONNECT_URL: "http://connect.example.test",
    NANGO_WEBHOOK_SIGNING_KEY: "test-webhook-key",
  };
  const first = invokeWithEnv(
    nangoEnv,
    "setup",
    "--shots-path",
    shots,
    "--port",
    "4300",
  );
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const path = join(directory, ".local/founder-hub/config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.shotsPath, shots);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const nangoPath = join(directory, ".local/founder-hub/nango.json");
  assert.deepEqual(JSON.parse(readFileSync(nangoPath, "utf8")), nangoEnv);
  assert.equal(statSync(nangoPath).mode & 0o777, 0o600);
  assert.ok(!(first.stdout + first.stderr).includes(nangoEnv.NANGO_API_KEY));
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
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);
  const capturedEnvPath = join(directory, "captured-nango-env.json");
  const captureScript = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(capturedEnvPath)}, JSON.stringify(Object.fromEntries(["NANGO_API_KEY", "NANGO_API_BASE", "NANGO_CONNECT_URL", "NANGO_WEBHOOK_SIGNING_KEY"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))))\n`;
  for (const binary of ["go", "native-api"]) {
    const binaryPath = join(fakeBin, binary);
    writeFileSync(binaryPath, captureScript, { mode: 0o700 });
    chmodSync(binaryPath, 0o700);
  }
  const servicePath = `${fakeBin}:${process.env.PATH}`;
  const serviceSetup = invokeWithEnv(
    { ...nangoEnv, PATH: servicePath },
    "setup",
    "--api-binary",
    join(fakeBin, "native-api"),
  );
  assert.equal(
    serviceSetup.status,
    0,
    serviceSetup.stderr + serviceSetup.stdout,
  );
  migrated.apiBinary = join(fakeBin, "native-api");
  const shotsAPI = invokeWithEnv({ PATH: servicePath }, "_run", "shots-api");
  assert.equal(shotsAPI.status, 0, shotsAPI.stderr + shotsAPI.stdout);
  assert.deepEqual(JSON.parse(readFileSync(capturedEnvPath, "utf8")), nangoEnv);
  const nativeAPI = invokeWithEnv({ PATH: servicePath }, "_run", "hub-core");
  assert.equal(nativeAPI.status, 0, nativeAPI.stderr + nativeAPI.stdout);
  assert.deepEqual(JSON.parse(readFileSync(capturedEnvPath, "utf8")), {
    NANGO_API_KEY: nangoEnv.NANGO_API_KEY,
    NANGO_API_BASE: nangoEnv.NANGO_API_BASE,
    NANGO_WEBHOOK_SIGNING_KEY: nangoEnv.NANGO_WEBHOOK_SIGNING_KEY,
  });
  const restartedServicesPath = join(directory, "restarted-services.txt");
  const processComposePath = join(fakeBin, "process-compose");
  writeFileSync(
    processComposePath,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(restartedServicesPath)}, process.argv.slice(2).join(" ") + "\\n")\n`,
    { mode: 0o700 },
  );
  chmodSync(processComposePath, 0o700);
  const sourceRestart = invokeWithEnv(
    { PATH: servicePath },
    "restart",
    "hub-api",
    "--source",
  );
  assert.equal(
    sourceRestart.status,
    0,
    sourceRestart.stderr + sourceRestart.stdout,
  );
  assert.deepEqual(
    readFileSync(restartedServicesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ").slice(-3).join(" ")),
    ["process restart hub-api", "process restart hub-core"],
  );
  assert.equal(JSON.parse(readFileSync(path, "utf8")).apiBinary, null);
  migrated.apiBinary = null;
  const partialNango = invokeWithEnv(
    { NANGO_API_KEY: nangoEnv.NANGO_API_KEY },
    "setup",
  );
  assert.equal(
    partialNango.status,
    0,
    partialNango.stderr + partialNango.stdout,
  );
  assert.deepEqual(JSON.parse(readFileSync(nangoPath, "utf8")), {
    NANGO_API_KEY: nangoEnv.NANGO_API_KEY,
  });
  const isolated = invoke(
    "setup",
    "--profile",
    "test",
    "--shots-path",
    shots,
    "--port",
    "4400",
  );
  assert.equal(isolated.status, 0, isolated.stderr + isolated.stdout);
  const isolatedConfigPath = join(
    directory,
    ".local/founder-hub-test/config.json",
  );
  assert.equal(
    JSON.parse(readFileSync(isolatedConfigPath, "utf8")).profileName,
    "test",
  );
  const isolatedProcesses = JSON.parse(
    readFileSync(
      join(directory, ".local/founder-hub-test/process-compose.json"),
      "utf8",
    ),
  ).processes;
  assert.match(isolatedProcesses["shots-api"].command, /--profile 'test'$/);
  assert.match(isolatedProcesses["hub-api"].command, /--profile 'test'$/);
  const isolatedTsconfigDir = join(shots, "clients/apps/web");
  const isolatedTsconfig = readdirSync(isolatedTsconfigDir).find((name) =>
    name.startsWith("tsconfig.local-"),
  );
  assert.ok(isolatedTsconfig);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(isolatedTsconfigDir, isolatedTsconfig), "utf8"),
    ),
    { compilerOptions: { strict: true } },
  );
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), migrated);
  const unsafeTest = invoke("test");
  assert.equal(unsafeTest.status, 1);
  assert.match(unsafeTest.stderr + unsafeTest.stdout, /isolated named profile/);
  const legacyDefault = { ...migrated };
  delete legacyDefault.profileName;
  writeFileSync(path, JSON.stringify(legacyDefault));
  const legacyTest = invoke("test");
  assert.equal(legacyTest.status, 1);
  assert.match(legacyTest.stderr + legacyTest.stdout, /isolated named profile/);
  writeFileSync(path, JSON.stringify(migrated));
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

test("local help exposes the combined integration test command", () => {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/local-dev.mjs"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\btest\b/);
  assert.match(result.stdout, /--profile test/);
});

import * as prompts from "@clack/prompts";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = join(root, ".local/founder-hub");
const configFile = join(state, "config.json");
const launcher = fileURLToPath(import.meta.url);
// macOS Unix socket paths are limited to 104 bytes; checkout paths can exceed that.
const supervisorSocket = join(
  tmpdir(),
  `shots-hub-${createHash("sha256").update(root).digest("hex").slice(0, 10)}.sock`,
);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const secret = () => randomBytes(32).toString("hex");
const baseEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "SystemRoot",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "DEVELOPER_DIR",
    "SDKROOT",
  ]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
baseEnv.PATH = `${dirname(process.execPath)}:${baseEnv.PATH}`;

function profile(config) {
  const names = [
    "web",
    "shots",
    "api",
    "backend",
    "postgres",
    "temporal",
    "temporalUi",
    "redis",
    "storageGateway",
    "rest",
    "storage",
    "core",
    "worker",
    "objects",
    "objectsConsole",
  ];
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65520
  )
    throw new Error("--port must be an integer between 1024 and 65520");
  const ports = Object.fromEntries(
    names.map((name, index) => [name, config.port + index]),
  );
  const urls = Object.fromEntries(
    names.map((name) => [name, `http://localhost:${ports[name]}`]),
  );
  const project = `founder-hub-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
  return { ports, urls, project };
}

async function run(
  command,
  args,
  { cwd = root, env = baseEnv, capture = false, timeout = 0 } = {},
) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    let errorOutput = "";
    if (capture) {
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        errorOutput = (errorOutput + data).slice(-2000);
      });
    }
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const timer = timeout
      ? setTimeout(() => child.kill("SIGKILL"), timeout)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`${command}: ${error.code ?? "could not start"}`));
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (code === 0) accept(output);
      else
        reject(
          new Error(
            `${command} failed (${signal ?? code}). ${errorOutput.trim()} See ${state}/logs for service output.`,
          ),
        );
    });
  });
}

async function loadConfig() {
  if (!existsSync(configFile))
    throw new Error("Run pnpm dev:local setup --shots-path ../shots first.");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  profile(config);
  if (
    !existsSync(join(config.shotsPath, "server/cmd/platform-migrate/main.go"))
  )
    throw new Error(`Shots checkout not found: ${config.shotsPath}`);
  return config;
}

function pc(args) {
  return run("process-compose", ["-U", "-u", supervisorSocket, ...args], {
    capture: true,
    timeout: 15_000,
  });
}

function docker(config, args, options = {}) {
  return run(
    "docker",
    [
      "compose",
      "-p",
      profile(config).project,
      "-f",
      join(state, "compose.json"),
      ...args,
    ],
    {
      env: {
        ...baseEnv,
        ...storageEnv(config),
        POSTGRES_PASSWORD: config.postgresPassword,
        REST_PASSWORD: config.restPassword,
        STORAGE_PASSWORD: config.storagePassword,
        RUSTFS_SECRET_KEY: config.objectPassword,
      },
      ...options,
    },
  );
}

function storageEnv(config) {
  const sign = (role) => {
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload =
      encode({ alg: "HS256", typ: "JWT" }) +
      "." +
      encode({
        role,
        iss: "shots-local",
        iat: 0,
        exp: 4102444800,
      });
    return (
      payload +
      "." +
      createHmac("sha256", config.storageJwtSecret)
        .update(payload)
        .digest("base64url")
    );
  };
  return {
    SUPABASE_URL: profile(config).urls.storageGateway,
    SUPABASE_ANON_KEY: sign("shots_hub_anon"),
    SUPABASE_SERVICE_ROLE_KEY: sign("shots_hub_service_role"),
    SUPABASE_JWT_SECRET: config.storageJwtSecret,
  };
}

function serviceEnv(config) {
  const { ports, urls } = profile(config);
  return {
    ...baseEnv,
    ...storageEnv(config),
    NODE_ENV: "development",
    PLATFORM_NEXT_DIST_DIR: `.next-founder-hub-${profile(config).project}`,
    GOFLAGS: "-p=2",
    GOMAXPROCS: "2",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "4",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_TARGET_DIR: join(root, "apps/desktop/src-tauri/target"),
    DATABASE_URL: `postgres://shots:${config.postgresPassword}@127.0.0.1:${ports.postgres}/shots?sslmode=disable`,
    FOUNDER_HUB_DB_REST_PASSWORD: config.restPassword,
    FOUNDER_HUB_DB_STORAGE_PASSWORD: config.storagePassword,
    TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    R2_ENDPOINT: urls.objects,
    R2_BROWSER_ENDPOINT: urls.objects,
    R2_REGION: "us-east-1",
    R2_BUCKET_NAME: "shots-local",
    R2_ACCESS_KEY_ID: "shots-local",
    R2_SECRET_ACCESS_KEY: config.objectPassword,
    PLATFORM_SOCIAL_ENCRYPTION_KEY: Buffer.from(
      config.socialEncryptionKey,
      "hex",
    ).toString("base64"),
    PLATFORM_WEBHOOK_ENCRYPTION_KEY: Buffer.from(
      config.webhookEncryptionKey,
      "hex",
    ).toString("base64"),
    AUDIT_DRAIN_ENCRYPTION_KEY: Buffer.from(
      config.auditEncryptionKey,
      "hex",
    ).toString("base64"),
    AUDIT_RETENTION_DATABASE_URL: `postgres://shots:${config.postgresPassword}@127.0.0.1:${ports.postgres}/shots?sslmode=disable`,
    AUTH_EMAIL_FROM: "Founder Hub <dev@example.test>",
    PUBLISHING_API_URL: `http://127.0.0.1:${ports.backend}`,
    PUBLISHING_SERVICE_TOKEN: config.serviceToken,
    BETTER_AUTH_SECRET: config.authSecret,
    BETTER_AUTH_URL: urls.shots,
    NEXT_PUBLIC_APP_URL: urls.shots,
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    SHOTS_AUTH_URL: urls.shots,
    SHOTS_AUTH_SERVICE_TOKEN: config.authorityToken,
    FOUNDER_HUB_WEB_ORIGIN: urls.web,
    FOUNDER_HUB_MCP_URL: `${urls.api}/mcp`,
    VITE_SHOTS_URL: urls.shots,
    VITE_API_URL: urls.api,
    VITE_APP_URL: urls.web,
    ANARLOG_DISABLE_SENTRY: "1",
    ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED: "false",
    RESEND_API_KEY: "local-unused",
    RESEND_FROM_EMAIL: "Founder Hub <dev@example.test>",
  };
}

async function writeConfiguration(config) {
  const { ports, project } = profile(config);
  await mkdir(join(state, "logs"), { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const compose = {
    services: {
      postgres: {
        image: "postgres:16-bookworm",
        environment: {
          POSTGRES_USER: "shots",
          POSTGRES_DB: "shots",
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?Local password is required}",
        },
        ports: [`127.0.0.1:${ports.postgres}:5432`],
        volumes: ["postgres:/var/lib/postgresql/data"],
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U shots -d shots"],
          interval: "2s",
          timeout: "5s",
          retries: 30,
        },
      },
      temporal: {
        image: "temporalio/temporal:1.8.2",
        command: [
          "server",
          "start-dev",
          "--ip",
          "0.0.0.0",
          "--db-filename",
          "/data/temporal.db",
        ],
        ports: [
          `127.0.0.1:${ports.temporal}:7233`,
          `127.0.0.1:${ports.temporalUi}:8233`,
        ],
        volumes: ["temporal:/data"],
        healthcheck: {
          test: [
            "CMD",
            "temporal",
            "operator",
            "cluster",
            "health",
            "--address",
            "127.0.0.1:7233",
          ],
          interval: "2s",
          timeout: "5s",
          retries: 30,
        },
      },
      redis: {
        image: "redis:7.4-alpine",
        ports: [`127.0.0.1:${ports.redis}:6379`],
        healthcheck: {
          test: ["CMD", "redis-cli", "ping"],
          interval: "2s",
          timeout: "5s",
          retries: 30,
        },
      },
      rest: {
        image: "postgrest/postgrest:v16.5",
        environment: {
          PGRST_DB_URI:
            "postgres://shots_hub_authenticator:${REST_PASSWORD:?Required}@postgres:5432/shots",
          PGRST_DB_SCHEMAS: "founder_hub",
          PGRST_DB_EXTRA_SEARCH_PATH: "extensions",
          PGRST_DB_ANON_ROLE: "shots_hub_anon",
          PGRST_DB_PRE_REQUEST: "founder_hub_private.check_shots_request",
          PGRST_DB_CONFIG: "false",
          PGRST_JWT_SECRET: "${SUPABASE_JWT_SECRET:?Required}",
        },
        ports: [`127.0.0.1:${ports.rest}:3000`],
      },
      rustfs: {
        image: "rustfs/rustfs:1.0.1",
        environment: {
          RUSTFS_ACCESS_KEY: "shots-local",
          RUSTFS_SECRET_KEY: "${RUSTFS_SECRET_KEY:?Required}",
          RUSTFS_CONSOLE_ENABLE: "true",
        },
        ports: [
          `127.0.0.1:${ports.objects}:9000`,
          `127.0.0.1:${ports.objectsConsole}:9001`,
        ],
        volumes: ["objects:/data"],
        healthcheck: {
          test: [
            "CMD-SHELL",
            "curl --fail --silent http://127.0.0.1:9000/health/live",
          ],
          interval: "2s",
          timeout: "5s",
          retries: 60,
        },
      },
      "rustfs-init": {
        image: "curlimages/curl:8.12.1",
        environment: {
          RUSTFS_ACCESS_KEY: "shots-local",
          RUSTFS_SECRET_KEY: "${RUSTFS_SECRET_KEY:?Required}",
          R2_BUCKET_NAME: "shots-local",
          R2_BROWSER_ORIGIN: profile(config).urls.shots,
        },
        volumes: [
          `${join(config.shotsPath, "infra/local/rustfs-init.sh")}:/rustfs-init.sh:ro`,
        ],
        entrypoint: ["/bin/sh", "/rustfs-init.sh"],
      },
      storage: {
        image: "supabase/storage-api:v1.48.27",
        environment: {
          DATABASE_URL:
            "postgres://shots_hub_storage:${STORAGE_PASSWORD:?Required}@postgres:5432/shots",
          AUTH_JWT_SECRET: "${SUPABASE_JWT_SECRET:?Required}",
          ANON_KEY: "${SUPABASE_ANON_KEY:?Required}",
          SERVICE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:?Required}",
          MULTI_TENANT: "false",
          DB_INSTALL_ROLES: "false",
          DB_ANON_ROLE: "shots_hub_anon",
          DB_AUTHENTICATED_ROLE: "shots_hub_authenticated",
          DB_SERVICE_ROLE: "shots_hub_service_role",
          DB_SUPER_USER: "shots_hub_owner",
          DATABASE_SEARCH_PATH: "founder_hub,extensions",
          TENANT_ID: project,
          STORAGE_BACKEND: "file",
          FILE_STORAGE_BACKEND_PATH: "/data",
          PG_QUEUE_ENABLE: "false",
          S3_PROTOCOL_ENABLED: "false",
          REGION: "local",
          PORT: "5000",
        },
        ports: [`127.0.0.1:${ports.storage}:5000`],
        volumes: ["attachments:/data"],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:5000/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "2s",
          timeout: "5s",
          retries: 60,
        },
      },
    },
    volumes: { postgres: {}, temporal: {}, attachments: {}, objects: {} },
  };
  await writeFile(
    join(state, "compose.json"),
    JSON.stringify(compose, null, 2),
  );
  const processes = {};
  for (const name of [
    "prepare",
    "shots-api",
    "shots-web",
    "hub-storage",
    "hub-api",
    "hub-core",
    "shots-worker",
    "ui",
    "hub-web",
  ]) {
    processes[name] = {
      command: `${quote(process.execPath)} ${quote(launcher)} _run ${name}`,
      working_dir: root,
      log_location: join(state, "logs", `${name}.log`),
    };
  }
  for (const name of [
    "shots-api",
    "hub-api",
    "hub-core",
    "hub-storage",
    "shots-worker",
  ])
    processes[name].depends_on = {
      prepare: { condition: "process_completed_successfully" },
    };
  processes["shots-web"].depends_on = {
    "shots-api": { condition: "process_healthy" },
  };
  processes["hub-api"].depends_on["shots-web"] = {
    condition: "process_healthy",
  };
  processes["hub-api"].depends_on["hub-storage"] = {
    condition: "process_healthy",
  };
  processes["hub-core"].depends_on = processes["hub-api"].depends_on;
  processes["hub-web"].depends_on = {
    ui: { condition: "process_completed_successfully" },
    "hub-api": { condition: "process_healthy" },
  };
  for (const [name, port, path] of [
    ["shots-api", ports.backend, "/readyz"],
    ["shots-web", ports.shots, "/sign-in"],
    ["hub-api", ports.api, "/health"],
    ["hub-core", ports.core, "/health"],
    ["shots-worker", ports.worker, "/readyz"],
    ["hub-storage", ports.storageGateway, "/healthz"],
    ["hub-web", ports.web, "/@vite/client"],
  ]) {
    processes[name].readiness_probe = {
      http_get: { host: "127.0.0.1", port, path },
      period_seconds: 3,
      timeout_seconds: 5,
      failure_threshold: 600,
    };
  }
  await writeFile(
    join(state, "process-compose.json"),
    JSON.stringify(
      {
        version: "0.5",
        is_strict: true,
        ordered_shutdown: true,
        log_configuration: {
          no_color: true,
          rotation: { max_size_mb: 20, max_backups: 2 },
        },
        processes,
      },
      null,
      2,
    ),
  );
}

async function setup(options) {
  if (existsSync(configFile)) {
    const config = await loadConfig();
    if (
      (options["shots-path"] &&
        resolve(options["shots-path"]) !== config.shotsPath) ||
      (options.port && Number(options.port) !== config.port)
    )
      throw new Error(
        "This checkout already has a local profile. Keep its path and port to preserve its data.",
      );
    for (const key of [
      "storageJwtSecret",
      "restPassword",
      "storagePassword",
      "objectPassword",
      "socialEncryptionKey",
      "webhookEncryptionKey",
      "auditEncryptionKey",
    ]) {
      config[key] ||= secret();
    }
    if (options["api-binary"]) {
      config.apiBinary = resolve(options["api-binary"]);
      if (!existsSync(config.apiBinary))
        throw new Error("--api-binary must name an existing local API build.");
    }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeConfiguration(config);
    return config;
  }
  let shotsPath = options["shots-path"] || resolve(root, "../shots");
  if (
    !existsSync(join(shotsPath, "server/cmd/platform-migrate/main.go")) &&
    process.stdin.isTTY
  ) {
    shotsPath = await prompts.text({
      message: "Path to your Shots backend checkout",
      initialValue: shotsPath,
    });
    if (prompts.isCancel(shotsPath)) throw new Error("Setup cancelled.");
  }
  shotsPath = resolve(shotsPath);
  if (!existsSync(join(shotsPath, "server/cmd/platform-migrate/main.go")))
    throw new Error(
      "Pass --shots-path with the Shots checkout containing server/ and clients/.",
    );
  const config = {
    shotsPath,
    port: Number(options.port || 4000),
    postgresPassword: secret(),
    serviceToken: secret(),
    authSecret: secret(),
    authorityToken: secret(),
    storageJwtSecret: secret(),
    restPassword: secret(),
    storagePassword: secret(),
    objectPassword: secret(),
    socialEncryptionKey: secret(),
    webhookEncryptionKey: secret(),
    auditEncryptionKey: secret(),
  };
  if (options["api-binary"]) {
    config.apiBinary = resolve(options["api-binary"]);
    if (!existsSync(config.apiBinary))
      throw new Error("--api-binary must name an existing local API build.");
  }
  profile(config);
  await writeConfiguration(config);
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return config;
}

async function doctor(config) {
  const checks = [
    ["pnpm", ["--version"]],
    ["go", ["version"]],
    ["cargo", ["--version"]],
    ["process-compose", ["version"]],
    ["docker", ["info", "--format", "{{.ServerVersion}}"]],
  ];
  for (const [command, args] of checks) {
    try {
      await run(command, args, { capture: true, timeout: 10_000 });
      prompts.log.success(`${command} ready`);
    } catch {
      throw new Error(
        `${command} unavailable. Start Docker Desktop; install Go, Rust, and process-compose (macOS: brew install f1bonacc1/tap/process-compose).`,
      );
    }
  }
  if (!existsSync(join(config.shotsPath, "clients/node_modules")))
    throw new Error(
      "Shots packages are missing. Run pnpm dev:local setup --install.",
    );
  prompts.log.info(
    `Node ${process.versions.node}; use the version pinned in package.json. Local email verification is disabled.`,
  );
}

async function healthy(url) {
  try {
    return (
      (
        await fetch(url, {
          signal: AbortSignal.timeout(3000),
          redirect: "manual",
        })
      ).status < 400
    );
  } catch {
    return false;
  }
}

async function status(config) {
  const { urls } = profile(config);
  let ready = true;
  for (const [name, url, probe] of [
    ["Shots", urls.shots, "/sign-in"],
    ["Founder Hub", urls.web, "/@vite/client"],
    ["Hub API", urls.api, "/health"],
    ["Hub cleanup", urls.core, "/health"],
    ["Shots worker", urls.worker, "/readyz"],
    ["Shots API", urls.backend, "/readyz"],
    ["Hub data API", urls.rest, "/"],
    ["Hub attachments", urls.storage, "/status"],
  ]) {
    const available = await healthy(url + probe);
    ready &&= available;
    prompts.log[available ? "success" : "warn"](
      `${name}: ${url} — ${available ? "ready" : "not ready"}`,
    );
  }
  prompts.note(
    `Shots database: 127.0.0.1:${profile(config).ports.postgres}/shots\nTemporal: ${urls.temporalUi}\nLogs: ${state}/logs`,
    "Local tools",
  );
  return ready;
}

async function runService(name, config) {
  const env = serviceEnv(config);
  const { ports } = profile(config);
  if (name === "prepare") {
    await docker(config, [
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "0:0",
      "--entrypoint",
      "chown",
      "temporal",
      "1000:1000",
      "/data",
    ]);
    await docker(config, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "postgres",
      "temporal",
      "redis",
      "rustfs",
    ]);
    await docker(config, ["run", "--rm", "--no-deps", "rustfs-init"]);
    await run(
      "go",
      ["run", "./cmd/platform-migrate", "--founder-hub=bootstrap"],
      {
        cwd: join(config.shotsPath, "server"),
        env,
      },
    );
    await docker(config, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "storage",
    ]);
    await run("go", ["run", "./cmd/platform-migrate", "--founder-hub=apply"], {
      cwd: join(config.shotsPath, "server"),
      env,
    });
    await docker(config, ["up", "-d", "rest"]);
    const deadline = Date.now() + 60_000;
    while (!(await healthy(profile(config).urls.rest))) {
      if (Date.now() >= deadline)
        throw new Error(
          "The Shots Founder Hub schema is not ready in PostgREST.",
        );
      await new Promise((accept) => setTimeout(accept, 1000));
    }
  } else if (name === "hub-storage") {
    await run("go", ["run", "./cmd/founder-hub-storage"], {
      cwd: join(config.shotsPath, "server"),
      env: {
        ...env,
        PORT: String(ports.storageGateway),
        FOUNDER_HUB_REST_ORIGIN: `http://127.0.0.1:${ports.rest}`,
        FOUNDER_HUB_STORAGE_ORIGIN: `http://127.0.0.1:${ports.storage}`,
      },
    });
  } else if (name === "shots-api") {
    await run("go", ["run", "./cmd/product-api"], {
      cwd: join(config.shotsPath, "server"),
      env: { ...env, PORT: String(ports.backend) },
    });
  } else if (name === "shots-worker") {
    await run("go", ["run", "./cmd/product-worker"], {
      cwd: join(config.shotsPath, "server"),
      env: { ...env, PORT: String(ports.worker), RUN_MAINTENANCE: "true" },
    });
  } else if (name === "shots-web") {
    await run(
      "npm",
      [
        "run",
        "dev",
        "--workspace",
        "screenshot-studio",
        "--",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(ports.shots),
      ],
      { cwd: join(config.shotsPath, "clients"), env },
    );
  } else if (name === "hub-api" || name === "hub-core") {
    await run(
      config.apiBinary || "cargo",
      config.apiBinary ? [] : ["run", "--locked", "-p", "api"],
      {
        env: {
          ...env,
          PORT: String(name === "hub-core" ? ports.core : ports.api),
          ANARLOG_SERVICE: name === "hub-core" ? "core" : "sync",
          ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED:
            name === "hub-core" ? "true" : "false",
        },
      },
    );
  } else if (name === "ui") {
    await run("pnpm", ["-F", "@anlg/ui", "build"], { env });
  } else if (name === "hub-web") {
    await run(
      "pnpm",
      [
        "-F",
        "@anlg/web",
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.web),
        "--strictPort",
      ],
      { env },
    );
  } else throw new Error("Unknown local service.");
}

async function freePort(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied. Stop its owner, or choose --port on first setup.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(accept));
  });
}

async function up(config) {
  await doctor(config);
  try {
    await pc(["process", "list", "--output", "json"]);
    return await status(config);
  } catch {}
  const { ports } = profile(config);
  for (const name of ["web", "shots", "api", "backend", "core", "worker"])
    await freePort(ports[name]);
  await pc([
    "--disable-dotenv",
    "-f",
    join(state, "process-compose.json"),
    "up",
    "-D",
  ]);
  const spin = prompts.spinner();
  spin.start(
    "Starting dependencies, migrations, and apps. First builds can take several minutes.",
  );
  const deadline = Date.now() + 30 * 60_000;
  const { urls } = profile(config);
  while (Date.now() < deadline) {
    if (
      (
        await Promise.all([
          healthy(`${urls.web}/@vite/client`),
          healthy(`${urls.core}/health`),
          healthy(`${urls.worker}/readyz`),
        ])
      ).every(Boolean)
    ) {
      spin.stop("Local stack is ready");
      await status(config);
      return true;
    }
    const processes = JSON.parse(
      await pc(["process", "list", "--output", "json"]),
    );
    const failed = processes.find(
      (entry) => entry.exit_code && entry.status === "Completed",
    );
    if (failed) {
      spin.stop(`${failed.name} failed`);
      throw new Error(
        `Read pnpm dev:local logs ${failed.name}, then run stop and up to retry. Data is preserved.`,
      );
    }
    await new Promise((accept) => setTimeout(accept, 2000));
  }
  spin.stop("Startup is still incomplete");
  throw new Error(
    "Run pnpm dev:local status and logs to inspect startup. Services were left running.",
  );
}

async function desktop(config) {
  if (!(await status(config)))
    throw new Error("Start the local stack with pnpm dev:local up first.");
  const env = serviceEnv(config);
  if (process.platform !== "darwin")
    throw new Error(
      "Packaged desktop launch currently supports macOS. Use the printed URLs for browser testing.",
    );
  await run("pnpm", ["-F", "@anlg/desktop", "build"], { env });
  await run(
    "pnpm",
    [
      "-F",
      "@anlg/desktop",
      "exec",
      "tauri",
      "build",
      "--debug",
      "--bundles",
      "app",
      "--features",
      "dev",
      "--config",
      JSON.stringify({
        build: { beforeBuildCommand: "" },
        bundle: { createUpdaterArtifacts: false },
      }),
    ],
    { env },
  );
  const bundleDir = join(env.CARGO_TARGET_DIR, "debug/bundle/macos");
  const app = (await readdir(bundleDir)).find((name) => name.endsWith(".app"));
  if (!app) throw new Error("The native build did not produce an app bundle.");
  const appPath = join(bundleDir, app);
  await run("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--identifier",
    "com.hyprnote.dev",
    "--requirements",
    '=designated => identifier "com.hyprnote.dev"',
    "--entitlements",
    join(root, "apps/desktop/src-tauri/Entitlements.plist"),
    appPath,
  ]);
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  prompts.note(
    "Quit any older Anarlog Dev process before testing. Sign in uses Shots in your browser and returns through the registered macOS callback.",
    "Desktop",
  );
  await run("open", [appPath]);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "shots-path": { type: "string" },
      port: { type: "string" },
      "api-binary": { type: "string" },
      install: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  let [command, target] = positionals;
  if (values.help) {
    console.log(
      "pnpm dev:local [setup|doctor|up|status|logs [service]|stop|open [shots|web|temporalUi]|desktop]\nsetup: --shots-path ../shots --port 4000 --install [--api-binary /path/to/local/api]\nNo command opens the Clack menu. stop preserves the Shots database and attachments.",
    );
    return;
  }
  if (command === "_run") return runService(target, await loadConfig());
  prompts.intro("Shots Founder Hub · local development");
  if (!command) {
    if (!process.stdin.isTTY)
      throw new Error(
        "Choose a command; use --help for non-interactive usage.",
      );
    command = await prompts.select({
      message: "What would you like to do?",
      options: [
        { value: "up", label: "Start local stack" },
        { value: "setup", label: "Set up this checkout" },
        { value: "doctor", label: "Check prerequisites" },
        { value: "status", label: "Show service status and URLs" },
        { value: "desktop", label: "Build and open desktop" },
        { value: "open", label: "Open local Shots" },
        { value: "logs", label: "View service logs" },
        { value: "stop", label: "Stop local stack (keep data)" },
      ],
    });
    if (prompts.isCancel(command)) {
      prompts.cancel("Cancelled");
      return;
    }
  }
  if (
    ![
      "setup",
      "doctor",
      "up",
      "status",
      "logs",
      "stop",
      "open",
      "desktop",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}. Use --help.`);
  const config =
    command === "setup" || command === "up"
      ? await setup(values)
      : await loadConfig();
  if (command === "setup") {
    if (
      values.install ||
      !existsSync(join(config.shotsPath, "clients/node_modules"))
    ) {
      await run("pnpm", ["install", "--frozen-lockfile"]);
      await run("npm", ["ci"], { cwd: join(config.shotsPath, "clients") });
    }
    prompts.log.success(
      "Profile ready. Run pnpm dev:local up, then pnpm dev:local desktop.",
    );
  } else if (command === "doctor") await doctor(config);
  else if (command === "up") {
    if (!(await up(config))) process.exitCode = 1;
  } else if (command === "status") {
    if (!(await status(config))) process.exitCode = 1;
  } else if (command === "desktop") await desktop(config);
  else if (command === "open") {
    target ||= "shots";
    if (!["shots", "web", "temporalUi"].includes(target))
      throw new Error("Choose shots, web, or temporalUi.");
    const url = profile(config).urls[target];
    if (!(await healthy(url)))
      throw new Error(`${target} is not ready; run pnpm dev:local status.`);
    await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  } else if (command === "logs") {
    if (!target && process.stdin.isTTY)
      target = await prompts.select({
        message: "Which service?",
        options: [
          "prepare",
          "shots-api",
          "shots-web",
          "hub-storage",
          "hub-api",
          "hub-core",
          "shots-worker",
          "ui",
          "hub-web",
        ].map((value) => ({ value, label: value })),
      });
    if (prompts.isCancel(target)) return;
    if (
      ![
        "prepare",
        "shots-api",
        "shots-web",
        "hub-storage",
        "hub-api",
        "hub-core",
        "shots-worker",
        "ui",
        "hub-web",
      ].includes(target)
    )
      throw new Error(
        "Choose prepare, shots-api, shots-web, shots-worker, hub-storage, hub-api, hub-core, ui, or hub-web.",
      );
    await run("tail", ["-n", "80", "-f", join(state, "logs", `${target}.log`)]);
  } else if (command === "stop") {
    try {
      await pc(["down"]);
    } catch {
      prompts.log.info("Process supervisor is already stopped or unavailable.");
    }
    await docker(config, ["stop"], { timeout: 60_000 });
    prompts.log.success(
      "Stopped. Local databases and credentials are preserved.",
    );
  }
  prompts.outro("Local only · no production credentials required");
}

main().catch((error) => {
  prompts.log.error(error.message);
  process.exitCode = 1;
});

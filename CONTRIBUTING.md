# Contributing

Issues, pull requests, bug reports, and documentation fixes are welcome.

## Before you start

- Search existing issues and pull requests before starting a large change.
- Keep changes focused. Add tests for behavior that can regress.
- Never commit credentials, customer configuration, meeting content, or other private data.
- Use [shots.playbookmedia.io/docs](https://shots.playbookmedia.io/docs) for product, CLI, and MCP behavior. Use this file and the repository's `AGENTS.md` files for development guidance.

## Set up the repository

You need:

- Node.js 22 or later
- pnpm 11.1.1
- Rust 1.94.0
- [process-compose](https://f1bonacc1.github.io/process-compose/installation/) 1.122.0 or later (`brew install process-compose` on macOS)
- The [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
- On Apple Silicon Macs, Xcode with its Metal Toolchain component. The Command Line Tools alone cannot compile the MLX shader library used by Soniqo local transcription. Xcode 26 and later install the component separately with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadComponent MetalToolchain`; Xcode does not need to be selected with `xcode-select`.

On Debian or Ubuntu, install the supported toolchains and system packages with:

```bash
bash scripts/setup-linux.sh
```

Then install the workspace:

```bash
pnpm install --frozen-lockfile
```

The desktop app and website start without secrets for local-first workflows.

## Run the apps

```bash
# Tauri desktop app
pnpm dev:desktop

# Website
pnpm dev:web
```

Process Compose manages the processes and logs. It runs the shared UI build through Turbo before starting either app. The existing `pnpm exec turbo dev:desktop` and `pnpm exec turbo dev:web` commands also work.

On macOS, install and select the full Xcode application, including its Metal
toolchain (`xcodebuild -downloadComponent MetalToolchain`). Command Line Tools
alone cannot build the on-device transcription dependencies. If the checkout
path contains spaces, set `CARGO_TARGET_DIR` to a path without spaces before
starting the desktop app; some native dependencies use Autotools, which rejects
build directories containing spaces.

`pnpm dev:desktop` and `pnpm dev:web` start individual applications. Use the
paired local stack below for PostgreSQL, S3 storage, Shots authentication, and
billing. `pnpm dev` starts the configured desktop/web/API processes; `pnpm
dev:api` starts the configured API. Both apply `task db-migrate` using
`DATABASE_URL` from `.env.cloud` and require the dependencies to be running.
Package `.env` files remain supported. See [apps/api/AGENTS.md](apps/api/AGENTS.md)
for required server configuration.

### Shots authentication

For an isolated local stack, use the Clack development CLI:

```sh
pnpm dev:local setup --shots-path ../shots --install
pnpm dev:local up
pnpm dev:local desktop
```

Run `pnpm dev:local` without arguments for the interactive menu. `doctor` checks
prerequisites; `status` prints health and URLs; `open shots` and `open web` open
the local apps; `logs <service>` follows logs; `stop` stops this stack while
preserving its databases. Setup accepts `--port 4000` as the first port in a
dedicated range, and optionally `--api-binary /path/to/api` to reuse a local API
build. Keep the same profile to retain its credentials and data.

The CLI needs the pinned Node/pnpm versions, Go, Rust, Docker Desktop, and
Process Compose (`brew install f1bonacc1/tap/process-compose` on macOS). Desktop
packaging also needs Xcode and the Metal toolchain
(`xcodebuild -downloadComponent MetalToolchain`). First builds and container
downloads can take several minutes and require substantial free disk space.
The packaged desktop command currently supports macOS; browser testing works
on macOS and Linux. Quit any older Shots Founder Hub Dev process before opening
the new bundle so the callback reaches the correct build.

This starts PostgreSQL, Redis, Temporal, RustFS (the local S3-compatible R2
replacement), both API servers, and both web apps. Credentials and logs live
under ignored `.local/founder-hub/`; no production credentials are required.
Create a local Shots account at the displayed Shots URL, then sign in from
Founder Hub. Email verification is disabled only in this local profile. AI,
recording providers, and integrations still need provider configuration.

The Go migration command owns the Shots tables. The Rust `cloud-db` migration
binary owns `founder_hub`, `founder_hub_identity`, `founder_hub_private`, and
`founder_hub_files` in the same PostgreSQL database. Run the Go command without
`--founder-hub=apply`; the local CLI then runs the Rust migrations. Migration
checksums and an advisory lock prevent concurrent or altered history execution.
The `cloud_api` runtime role uses transaction-scoped identity and PostgreSQL RLS.
Only migration administrators create schema or roles.

Set `SHOTS_AUTH_URL` and the same random `SHOTS_AUTH_SERVICE_TOKEN` (at least 32
bytes) on the Hub API and Shots web server. Never expose this token in a public
build variable. Set `DATABASE_URL`, `CLOUD_SIGNING_KEY`, `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` on the API. R2 uses its S3 endpoint
and region `auto`; the bucket holds logical prefixes for audio, backups, and
shared attachments. Grant the API credentials object access only to that bucket.

Set `VITE_SHOTS_URL`, `VITE_API_URL`, and `VITE_R2_DOWNLOAD_BASE_URL` for desktop
and web. Mobile uses `EXPO_PUBLIC_SHOTS_URL`, `EXPO_PUBLIC_API_URL`, and
`EXPO_PUBLIC_R2_DOWNLOAD_BASE_URL`. The R2 download base is the exact endpoint
plus bucket path; native clients reject other hosts and paths. User requests use
`/cloud`, which checks the current Shots session and projects permissions into
PostgreSQL. Account, team, and billing changes use Shots settings. Encrypted
replica sync does not require SQLite Cloud credentials.

Set `VITE_APP_URL` to the Hub web origin and run Shots `platform-migrate` with
`FOUNDER_HUB_WEB_ORIGIN` set to that origin to register `/callback/shots/`.
HTTPS is required outside loopback development. Public shared-note requests also
use the Hub API. Enable `ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED` on only one core
or combined runtime for durable attachment and account cleanup.

Configure the production R2 bucket CORS rules to allow the exact web and desktop
origins, `GET`/`PUT`/`HEAD`, request headers, and expose `ETag`. Enable a lifecycle
rule to abort incomplete multipart uploads after one day. The local stack applies
these settings with `scripts/local-r2-init.sh`. Browser grants expire after 15
minutes; ordinary download URLs expire within one hour.

Existing deployments require a separate data cutover. Back up the source database
and storage first, stop writers and cleanup workers, and restore the Hub data into
the target schemas. Preserve user/workspace UUIDs, encrypted bytes, and object
keys. Copy each storage bucket to the matching R2 logical prefix, verify row
counts and object sizes/checksums, then switch API and client configuration.
Do not run the fresh-schema migrator over an existing legacy Hub schema: it
refuses conflicting objects instead of dropping data. The old database and bucket
must remain available for rollback until the cutover is verified. These repository
changes do not move hosted data or modify cloud credentials.

The CLI uses `ANARLOG_SHOTS_URL` and `ANARLOG_API_URL` (or the corresponding
`VITE_` values embedded at build time). `sfh auth login` prints a PKCE
sign-in URL and receives the callback on loopback. It creates a separate Shots
session in `auth.shots-cli.json`, refreshes it automatically, and revokes it on
`sfh auth logout`. `ANARLOG_AUTH_PATH` overrides that file for isolated tests;
do not point it at the desktop session file.

Set the same `FOUNDER_HUB_MCP_URL` on the Shots web server and Founder Hub sync API
to the public `https://<hub-api>/mcp` URL (loopback HTTP is allowed locally).
Connectors discover Shots as their OAuth issuer and register public PKCE clients
with read-only meeting access. Consent, a live Shots session, an active grant,
a paid workspace, and Cloud API opt-in are required on every connector request.
Native credentials remain required for snapshot publication and key/settings management.
Disabling Cloud API access removes uploaded snapshots; enabling it again requires
republishing them.

Existing Anarlog accounts require an explicit identity/data migration before
cutover. The authority projector rejects identity collisions instead of linking
accounts by matching email addresses.

Use the Process Compose TUI to view logs or restart individual processes. Logs are also written under `.process-compose/<target>/`, with rotation; set `PC_LOG_DIR` to override that directory. The launcher disables the TUI automatically without a terminal, or you can set `PC_DISABLE_TUI=1`.

The control ports are 18080 for `pnpm dev`, 18081 for desktop, 18082 for web, and 18083 for API. Set `PC_PORT_NUM` to override a control port; app ports remain 1422 (desktop Vite), 3000 (web), and 3001 (API). Stop other apps using those app ports before starting the same services here.

```bash
# Validate configuration without starting apps
pnpm dev --dry-run

# Start web without the TUI and restart it from another terminal
pnpm dev:web -t=false
process-compose -p 18082 process restart web
process-compose -p 18082 down
```

### Develop the Google Drive automation

Run the desktop, web (`:3000`), and API (`:3001`) development commands above in
separate terminals. Configure the existing Nango `google-drive` integration with
`https://www.googleapis.com/auth/drive.file` and the team's development OAuth
client. Enable the Google Drive and Google Picker APIs in that client's Google
Cloud project. Existing connections with broader scopes must be reauthorized.

To test hosted transcription and summaries while keeping Drive requests local,
set `VITE_API_URL=http://localhost:3001` and
`VITE_AI_API_URL=https://api.shots.playbookmedia.io` in `apps/desktop/.env`, then
restart the desktop dev process. This requires an account and Pro entitlement
accepted by the hosted service. The local API can remain `ANARLOG_SERVICE=core`.
Omitting `VITE_AI_API_URL` keeps AI requests on `VITE_API_URL`. Explicit
provider base URL settings still take precedence. Audio and summary requests use
the hosted service and its normal usage limits.

Set `GOOGLE_DRIVE_PICKER_REDIRECT_URI` in `apps/api/.env` to
`http://localhost:3000/app/google-drive-picker` for local development. Register
that exact URI on the **same Google OAuth client configured in Nango**, in its
authorized redirect URIs. Keep Nango's existing callback URI as well. Production
must use the deployed web origin with HTTPS and this same route path.

Folder selection opens Google's OAuth page directly using `trigger_onepick` and
`drive.file`; it does not embed the JavaScript Picker. No Picker API key or
`VITE_GOOGLE_DRIVE_PICKER_*` variables are needed. The API obtains the OAuth
client credentials from Nango, validates signed user-bound state and PKCE,
checks that the selected Google account matches the existing connection, and
imports the new credentials into that same Nango connection. The Nango API key
must permit reading integration credentials and importing connections.

The web page uses same-tab session storage only for return routing, clears the
OAuth code from the URL before telemetry, and hands it to the authenticated
desktop for API completion. Access and refresh tokens stay on the server.
Restart selection from the desktop if the callback tab is refreshed or closed.
Nango's new-connection webhook still needs a reachable local tunnel; the direct
folder-selection callback goes to the web app and does not use that tunnel.

Validate with a test My Drive folder and a test shared-drive folder. Verify
folder selection, a first upload, an update after regenerating a summary, and a
failed upload retry. Deploy the API and web support before distributing a desktop
build that exposes the action.

## Find the right code

| Path             | Scope                                                   |
| ---------------- | ------------------------------------------------------- |
| `apps/desktop`   | React desktop UI and Tauri application                  |
| `apps/web`       | Marketing site, account portal, and shared-note pages   |
| `apps/api`       | Hosted API routes                                       |
| `apps/cli`       | CLI and MCP server                                      |
| `apps/mobile`    | Expo mobile client                                      |
| `plugins/*`      | Tauri plugin boundaries                                 |
| `crates/*`       | Rust libraries and services                             |
| `packages/*`     | Shared TypeScript packages                              |
| `crates/db-app`  | SQLite schema and migrations                            |
| `postgres`       | PostgreSQL schema, functions, migrations, and tests     |
| `skills/sfh`     | Published CLI and MCP agent skill                       |
| `enterprise`     | Commercially licensed capture and deployment components |
| `docs`           | Mintlify product and reference documentation            |

Sessions are the core data entity. Notes, transcripts, and summaries are all backed by sessions. ProseMirror documents use the TipTap JSON dialect.

## Validate your change

Always format before committing:

```bash
pnpm exec dprint fmt
pnpm fmt:check
```

On Linux, the full format check cannot run the macOS-only Swift formatter. Run a scoped dprint check for every changed non-Swift path and report the skipped Swift check.

Run checks for every package you changed. Common commands include:

```bash
# Desktop TypeScript
pnpm -F desktop typecheck
pnpm -F desktop test
pnpm exec oxlint --quiet --format=github apps/desktop/src/

# Changes spanning TypeScript packages
pnpm -r typecheck

# Rust
cargo check
cargo test -p <affected-package>
```

For documentation changes:

```bash
pnpm exec dprint fmt 'docs/**/*'
pnpm exec dprint check 'docs/**/*'
cd docs
mint validate
mint broken-links --check-anchors --check-redirects
```

Check the affected workflow under `.github/workflows/` for stricter package-specific commands.

## Open a pull request

- Write the title as a specific action that states the intended outcome. Do not use a file name, ticket number, or a generic label as the title.
- Write one or two sentences on the labeled `Intent` line: what problem you saw, and what this change should do instead. Cubic already summarizes the code diff, so do not paste a generated commit log, a file-by-file recap, or a long write-up: keep it short.
- Attach a short screen recording or GIF in the `Demo` section showing the problem and the fix in action. This, plus the one-line intent, is what lets a maintainer understand a contribution without reading a wall of text. Docs-only or non-functional changes can skip the video by writing `N/A` and a one-line reason.
- List the commands and manual checks you used to verify the change.
- CI enforces the title, the labeled `Intent` line, and the `Demo` section for external contributors. Org members, collaborators, owners, and bots are not gated.

## Licensing and contribution boundary

By submitting a contribution outside `enterprise/`, you agree that it may be distributed under the repository's [MIT License](LICENSE). Only submit material you have the right to license this way.

Do not submit changes under `enterprise/` unless Fastrepl has confirmed the applicable contribution terms in writing. Never include customer configuration, credentials, confidential material, or untracked third-party code. Record the immutable upstream revision and license before reusing third-party material. See [Licensing and product boundary](LICENSING.md) for the component-placement and provenance rules.

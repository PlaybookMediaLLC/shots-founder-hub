```bash
infisical export \
  --env=dev \
  --secret-overriding=false \
  --format=dotenv \
  --output-file="apps/api/.env" \
  --projectId=04ebc1cf-0ec5-4e9e-8ab9-4c6da4252574 \
  --path="/founder-hub"
```

`/anarlog/ai` is the API runtime view. Its Nango entries should reference the
source secrets in `/anarlog/nango` rather than requiring API jobs to export a
second secret path.

## Service runtimes

`ANARLOG_SERVICE` selects the routes started by the shared API binary:

| Value | Routes |
| --- | --- |
| `all` (default) | Existing combined API, preserving current client URLs |
| `ai` | Transcription, LLM, research, diarization, and STT callbacks |
| `sync` | Sync, devices, attachments, sharing, hosted meeting API/MCP |
| `core` | Nango and integration APIs, durable Shots account cleanup |

All roles require `DATABASE_URL`, `CLOUD_SIGNING_KEY` (32 bytes minimum),
`R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`SHOTS_AUTH_URL`, and `SHOTS_AUTH_SERVICE_TOKEN`. SeaORM connects directly to
PostgreSQL. Shots owns authentication, account changes, and billing; this
repository has no Stripe service or standalone authentication server.

Run `cargo run --locked -p cloud-db --bin migrate` with a migration administrator
before starting services. Runtime credentials should use `cloud_api`; the
migration administrator must be able to create roles and extensions. Do not use
runtime credentials to run migrations. Sync and combined roles also require
`FOUNDER_HUB_MCP_URL`.

Only `ai` and `all` require
`OPENROUTER_API_KEY` and `API_BASE_URL`; the sync runtime requires its shared-note
email configuration. Optional integration groups are validated only in their
owning roles. `ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED` is accepted only by `core`
and `all`. Assign cleanup to one deployment during migration.

`api_cd.yaml` deploys one DigitalOcean App Platform app, `founder-hub-api`.
It runs the `ai`, `sync`, and `core` roles as internal services. A public
`gateway` service runs the combined role and forwards each role's routes to
them, so all public URLs stay on `founder-hub-api.shots.playbookmedia.io`.
`.github/scripts/render_api_app_spec.py` owns the app spec. Core owns durable
cleanup; other services disable it. Never transfer cleanup ownership until the
previous owner's worker has stopped.

`/health/ready/{service}` verifies the expected runtime role, configuration of
its primary subsystems, and that it is not draining. The combined role uses
`api`. These checks do not probe external providers or prove request
continuity. App Platform health checks use `/health`, because readiness also
requires optional integrations.

The combined compatibility runtime can forward each role through
`ANARLOG_AI_ORIGIN`, `ANARLOG_SYNC_ORIGIN`, `ANARLOG_CORE_ORIGIN`. Unset origins keep the existing local route behavior.
The proxy preserves uploads, response streams, and WebSocket upgrades; it does
not retry writes or follow redirects. Drain permits cover proxied requests and
upgraded connections through completion. Origins are rejected in standalone
roles to prevent routing cycles.

`api_cd.yaml` runs on pushes to `main` that change the API and on manual
dispatch. It builds one image in GHCR, then updates every service to that tag.
A PRE_DEPLOY job runs `/usr/local/bin/migrate` with `DATABASE_MIGRATION_URL`
before the new services start. The workflow reads secrets from Infisical
(Desktop App Backend, `prod`, `/founder-hub`) through GitHub OIDC, and gives each
service only its role's secrets. A deploy replaces instances, so it ends active
live-transcription streams.

Deploys are off unless the repository variable `API_DEPLOY_ENABLED` is `true`.
While they are off, `api_cd.yaml` runs its `pause` job instead, which archives
the app (App Platform maintenance `archive`) so no container runs. Setting the
variable to `true` and dispatching `api_cd.yaml` deploys and unarchives it.

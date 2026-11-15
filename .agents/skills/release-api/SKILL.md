---
name: release-api
description: Review Anarlog API contracts and generated clients, deploy required hosted services and database changes, and verify live release behavior.
metadata:
  internal: true
---

# Release API

Review every release, including client-only changes. Inherit scope and session
authorization from [Release a New Version](../release-new-version/SKILL.md).

1. Compare changed product behavior and each service's live source SHA against
   `apps/api`, `crates/api-cloud`, affected auth/sync/proxy crates, `crates/cloud-db`,
   `postgres/`, `apps/api/openapi.gen.json`, and `packages/api-client/src/generated`.
   Check auth, scopes, payloads/errors, pagination, data compatibility, and existing
   client behavior. Record required changes, concrete reuse reasons, or explicit
   deferrals before freezing the candidate.
2. Read `api_ci.yaml`, `api_cd.yaml`, and `db_ci.yaml` plus the
   affected component instructions. Run the full locally reproducible affected
   jobs and consumer checks. For contract changes, run:

   ```bash
   cargo test -p api gen_openapi_json
   pnpm -F @anlg/api-client openapi
   pnpm -F @anlg/api-client typecheck
   ```

   Use owning generators and verify repeated generation is stable. Test hosted
   migrations/RLS in an isolated local Postgres as `db_ci.yaml` does, never against production.
3. Inspect current service choices and live configuration before deploying.
   One `api_cd.yaml` run deploys the gateway and the ai, sync, and core services
   from one image, and its PRE_DEPLOY job applies the Postgres migrations. Shots
   owns billing, so this repo deploys no billing service.
4. Deploy required backward-compatible hosted changes before dependent desktop
   or mobile clients. Select the exact approved environment, service and merged
   source. A push to `main` that changes the API deploys it; use
   `gh workflow run api_cd.yaml --ref main` to redeploy. Verify each run's `headSha`; never ship the combined GitButler
   workspace. Include every dependency in filtered Docker build contexts.
5. Follow deployments to terminal success. Confirm actual serving source/digest,
   version and role-specific readiness, then exercise affected authenticated
   behavior with an authorized test account. `/health`, an unauthenticated `401`,
   or one healthy role does not prove other roles or operations work. Coordinate
   hosted protocol checks with [Release MCP](../release-mcp/SKILL.md).
6. For schema changes, record the selected hosted project, applied migrations,
   source/run and compatibility checks. Keep shipped SQLite migrations append-only,
   desktop/mobile schemas compatible, and older clients supported. Follow current
   drain, migration, continuity, and recovery requirements; successful health checks
   alone do not establish zero downtime.

Return generated-contract decisions, candidate CI, each service/database's deployed
revision and run URL, live evidence, or reuse reason and outstanding work. Reuse a
live deployment only when its source includes the required changes; no artificial
version bumps or no-op redeploys. Website and Mintlify publication belong to
[Release Docs](../release-docs/SKILL.md), not the API deploy.

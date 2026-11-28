# Shots Founder Hub documentation

This Mintlify project is published at [docs.shots.playbookmedia.io](https://docs.shots.playbookmedia.io).

## Deployment

Configure the Mintlify project with `docs/` as its documentation directory and `docs.shots.playbookmedia.io` as its custom domain. In Mintlify's domain setup:

1. Add the verification records shown in the dashboard.
2. Wait for both records and TLS provisioning to verify.
3. Point the `docs` CNAME to the target shown by Mintlify.

The website redirects its `/docs` routes to the Shots documentation at `https://shots.playbookmedia.io/docs`.

## Local preview

Install the Mintlify CLI, then run it from this directory:

```bash
npm install --global mint
cd docs
mint dev
```

Update `docs.json` whenever a page is added, moved, or removed. Keep CLI and MCP reference content aligned with `apps/cli/src/cli.rs` and `apps/cli/src/mcp.rs`. Mintlify publishes the custom agent skill from `skill.md`; keep it aligned with `../skills/sfh/`.

Before deploying, run:

```bash
mint validate
mint broken-links --check-anchors --check-redirects
```

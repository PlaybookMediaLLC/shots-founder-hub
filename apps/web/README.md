# @anlg/web

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/fork/github/fastrepl/anarlog/tree/main)

This app is not deployed. Users reach Founder Hub through Shots
(`https://shots.playbookmedia.io`), which owns accounts, teams, billing, and the
Founder Hub management pages. `web_ci.yaml` runs the typecheck, tests, and the
figure check; it does not deploy.

`public/apt` holds the signed APT metadata for the Linux desktop app.
`desktop_release.yaml` builds the packages, publishes the GitHub release,
and pushes new metadata here. Shots redirects `https://shots.playbookmedia.io/apt`
to these files on `main` and to the release assets. The signing keys are in the
`desktop-release` GitHub environment, with backups in Infisical
(Desktop App Backend, `prod`, `/desktop-release`) and Azure Key Vault
`fh-desktop-release-kv`.

`vercel-build-config.ts` stays because `vite.config.ts` and `src/lib/image-cdn.ts`
use its routes and image sizes.

Local development uses `pnpm dev:web` from the repository root. Local image requests
redirect to their original assets; Vercel performs width-based image
optimization in deployment, while CSS controls cropping. A local production
build uses `.output`; `NITRO_PRESET=vercel pnpm -F @anlg/web build` produces
`.vercel/output`. Production builds require the web build environment.

References: [TanStack Start on Vercel](https://vercel.com/kb/guide/deploy-a-tanstack-start-app-to-vercel),
[build output and image configuration](https://vercel.com/docs/build-output-api/configuration),
[cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

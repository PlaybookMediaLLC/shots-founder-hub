# Shots Founder Hub — Google Cloud Console (Runner) Configuration Plan

**Status:** Production provisioned & wired (`shots-founder-hub-prod`, Nango Cloud `prod`, Infisical `Desktop App Backend` -> `prod` -> `/founder-hub`).

## Verified Production Identifiers

| Surface | Verified Value |
| --- | --- |
| **GCP Project (Prod)** | `shots-founder-hub-prod` (`309614338372`, Org `353731453547`, Billing `010B75-F0E666-B72227`) |
| **Artifact Registry** | `us-west1-docker.pkg.dev/shots-founder-hub-prod/shots-founder-hub` |
| **GitHub Actions WIF Provider** | `projects/309614338372/locations/global/workloadIdentityPools/github-actions-pool/providers/github-oidc` |
| **OAuth Client (`google-calendar`)** | `309614338372-bf0tmjalveh5r6muadftlai0u95ts51g.apps.googleusercontent.com` |
| **OAuth Client (`google-drive`)** | `309614338372-fbgu65hk1152l1plu6ljpqdq3p2ofted.apps.googleusercontent.com` |
| **OAuth Client (`google-meet`)** | `309614338372-6jlllki6bv17e8gsq8fbfn0bqv9ghaie.apps.googleusercontent.com` |
| **Nango Cloud (`prod`)** | Environment ID `58b2a4bc-dc31-456e-af8d-6abc2fd67460` (`https://shots.playbookmedia.io/oauth/callback`, `https://hub.usedante.app/nango/webhook`) |
| **Infisical (`Desktop App Backend`)** | Project ID `04ebc1cf-0ec5-4e9e-8ab9-4c6da4252574`, folder `prod` -> `/founder-hub`, OIDC Machine Identity `ff0e209b-9fe1-4a6c-aeef-e78ee1623967` (`founder-hub-github-production`) |

## Confirmed Decisions

| Decision | Selection |
| --- | --- |
| **Scope** | **All** — Track A (OAuth/APIs for Calendar, Drive automation runner + OnePick, Meet, Nango Cloud, Infisical) **and** Track B (GCP Cloud Run API hosting + CI/workload runners via Workload Identity Federation, Artifact Registry, least-privilege IAM, Secret Manager) |
| **Nango hosting** | **Nango Cloud** (`https://api.nango.dev`) with branded `308` callback proxy at `https://shots.playbookmedia.io/oauth/callback` |
| **OAuth client layout** | **3 separate Web Application OAuth 2.0 clients** per GCP project (`shots-founder-hub-calendar`, `shots-founder-hub-drive`, `shots-founder-hub-meet`) |
| **`google-meet` identity scopes** | **Added** — `openid`, `userinfo.email`, `userinfo.profile` (non-sensitive) added to `GOOGLE_MEET_OAUTH_SCOPES` so `crates/api-nango/src/routes/identity.rs` populates connected account email/name |
| **GCP projects** | `shots-founder-hub-dev` (Dev/Staging, Testing consent screen) and `shots-founder-hub-prod` (Production, Verified consent screen) |

---

## Architecture & Auth Boundary

- **Shots (`shots.playbookmedia.io` / `SHOTS_AUTH_URL`)** owns user authentication, workspaces, roles, and billing (`client_id = "shots-founder-hub"`). Founder Hub does not duplicate Google Sign-In OAuth when `VITE_SHOTS_URL` / `SHOTS_AUTH_URL` is configured.
- **Founder Hub Web (`shots.playbookmedia.io`)** hosts:
  - `/oauth/callback` — branded `308` redirect (`Cache-Control: no-store`) to `https://api.nango.dev/oauth/callback` (`apps/web/src/lib/oauth-callback.ts`).
  - `/app/integration` — desktop/web Nango connect handoff.
  - `/app/google-drive-picker` — direct Google OnePick PKCE folder selection callback (`GOOGLE_DRIVE_PICKER_REDIRECT_URI`).
  - `/privacy` and `/terms` — public legal notices required for Google OAuth verification.
- **Founder Hub API (`hub.usedante.app` — Google Cloud Run `founder-hub-api` in `shots-founder-hub-prod` / `us-west1`; DigitalOcean App Platform kept off)** handles Nango sessions, HMAC-verified webhooks (`/nango/webhook`), proxied Calendar/Drive/Meet API calls, and direct Google Drive OnePick PKCE exchange (`/nango/google-drive/picker-start`, `/nango/google-drive/picker-complete`).
- **GCP Runner Infrastructure (Track B)** provides keyless GitHub Actions OIDC via Workload Identity Federation (WIF), Artifact Registry (`us-west1`), Secret Manager, and least-privilege Service Accounts (`sa-ci-runner`, `sa-deploy`, `sa-api-runtime`, `sa-meet-worker`) with zero static JSON keys.

---

## Step 1 — Provision GCP Projects, APIs & Runner Infrastructure

Run the idempotent provisioning script for both environments (preview with `--dry-run` first):

```bash
# Preview commands without mutating GCP
./scripts/gcp/provision-gcp-runner.sh --env dev --dry-run
./scripts/gcp/provision-gcp-runner.sh --env prod --dry-run

# Apply to dev and prod (pass --org and --billing-account on first creation)
./scripts/gcp/provision-gcp-runner.sh --env dev --org "<GCP_ORG_ID>" --billing-account "<BILLING_ACCOUNT_ID>"
./scripts/gcp/provision-gcp-runner.sh --env prod --org "<GCP_ORG_ID>" --billing-account "<BILLING_ACCOUNT_ID>"
```

### Enabled APIs
- **Track A (Integrations & Automation Runner):**
  - `calendar-json.googleapis.com` (Google Calendar API)
  - `drive.googleapis.com` (Google Drive API)
  - `meet.googleapis.com` (Google Meet REST API)
- **Track B (GCP CI / Workload Runners):**
  - `iam.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`
  - `artifactregistry.googleapis.com`, `run.googleapis.com`, `compute.googleapis.com`
  - `secretmanager.googleapis.com`, `logging.googleapis.com`, `monitoring.googleapis.com`
- **Explicitly Excluded:**
  - `gmail.googleapis.com` **must remain disabled** on both projects to avoid triggering Google's Restricted Scope CASA Tier 2 security assessment.

### Track B Workload Identity Federation & Service Accounts
- **Pool:** `github-actions-pool` (`global`)
- **Provider:** `github-oidc` (`https://token.actions.githubusercontent.com`)
- **Attribute condition:** Restricted strictly to `PlaybookMediaLLC/shots-founder-hub` and `PlaybookMediaLLC/shots`.
- **Service Accounts (zero static JSON keys):**
  - `sa-ci-runner@<project>.iam.gserviceaccount.com` — Artifact Registry writer + logging/monitoring writer.
  - `sa-deploy@<project>.iam.gserviceaccount.com` — Cloud Run admin + Secret Manager admin + Artifact Registry reader + Service Account user, restricted to `refs/heads/main` / `environment:production` (prod) or `refs/heads/develop` (dev).
  - `sa-api-runtime@<project>.iam.gserviceaccount.com` — Cloud Run runtime account for `founder-hub-api` and `founder-hub-api-migrate` with `roles/secretmanager.secretAccessor`, `roles/logging.logWriter`, and `roles/monitoring.metricWriter`.
  - `sa-meet-worker@<project>.iam.gserviceaccount.com` — minimal runtime account for `enterprise/google-meet-worker` (headless browser bot; needs no Google Workspace API credentials; bind `roles/secretmanager.secretAccessor` per secret only).

---

## Step 2 — Configure Google Auth Platform (Console UI)

Complete the following in **Google Cloud Console -> Google Auth Platform** for `shots-founder-hub-dev` (Testing mode) and `shots-founder-hub-prod` (Production):

1. **Google Search Console Verification:** Verify DNS ownership of `playbookmedia.io` under the submitting GCP project admin account.
2. **Branding:**
   - App name: `Shots Founder Hub` (dev: `Shots Founder Hub Dev`)
   - User support & developer contact emails: Playbook-owned `@playbookmedia.io` addresses (e.g., `team@playbookmedia.io`)
   - Homepage: `https://shots.playbookmedia.io`
   - Privacy Policy: `https://shots.playbookmedia.io/privacy`
   - Terms of Service: `https://shots.playbookmedia.io/terms`
   - Authorized domains: `playbookmedia.io`
3. **Data Access (Scopes):**
   - `https://www.googleapis.com/auth/calendar.readonly` *(Sensitive)*
   - `https://www.googleapis.com/auth/calendar.events.readonly` *(Sensitive)*
   - `https://www.googleapis.com/auth/drive.file` *(Non-sensitive)*
   - `https://www.googleapis.com/auth/meetings.space.readonly` *(Sensitive)*
   - `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile` *(Non-sensitive)*
4. **Clients — Create 3 Separate OAuth 2.0 Web Application Clients per Project:**

| Client Name | Environment | Authorized JS Origins | Authorized Redirect URIs |
| --- | --- | --- | --- |
| `shots-founder-hub-calendar` | Prod | `https://shots.playbookmedia.io` | `https://shots.playbookmedia.io/oauth/callback` |
| `shots-founder-hub-drive` | Prod | `https://shots.playbookmedia.io` | `https://shots.playbookmedia.io/oauth/callback`<br>`https://shots.playbookmedia.io/app/google-drive-picker` |
| `shots-founder-hub-meet` | Prod | `https://shots.playbookmedia.io` | `https://shots.playbookmedia.io/oauth/callback` |
| `shots-founder-hub-calendar` | Dev | `http://localhost:3000`<br>`http://localhost:4400` | `https://api.nango.dev/oauth/callback` |
| `shots-founder-hub-drive` | Dev | `http://localhost:3000`<br>`http://localhost:4400` | `https://api.nango.dev/oauth/callback`<br>`http://localhost:3000/app/google-drive-picker`<br>`http://localhost:4400/app/google-drive-picker` |
| `shots-founder-hub-meet` | Dev | `http://localhost:3000`<br>`http://localhost:4400` | `https://api.nango.dev/oauth/callback` |

---

## Step 3 — Configure Nango Cloud, Infisical & Google Cloud Run

1. **Nango Cloud (Dev & Prod environments):**
   - Set **Custom Callback URL** in Production to `https://shots.playbookmedia.io/oauth/callback`.
   - Configure custom OAuth Client ID & Secret for each of the 3 providers:
     - `google-calendar` -> `shots-founder-hub-calendar` (scopes: `calendar.readonly`, `calendar.events.readonly`)
     - `google-drive` -> `shots-founder-hub-drive` (scope: **strictly** `https://www.googleapis.com/auth/drive.file` alone — `google_drive_oauth.rs` rejects extra scopes)
     - `google-meet` -> `shots-founder-hub-meet` (scopes: `meetings.space.readonly`, `openid`, `userinfo.email`, `userinfo.profile`)
   - Configure **Webhook URL** -> `https://hub.usedante.app/nango/webhook` (Auth + Forward webhooks) and copy the HMAC signing key.
2. **Infisical & Google Cloud Run (`founder-hub-api`, DigitalOcean off):**
   - Secrets live in Infisical `Desktop App Backend` (`04ebc1cf-0ec5-4e9e-8ab9-4c6da4252574`) -> `prod` -> `/founder-hub` (read via OIDC Machine Identity `ff0e209b-9fe1-4a6c-aeef-e78ee1623967`) and are synced into GCP Secret Manager on deploy:
     - `NANGO_API_KEY`
     - `NANGO_WEBHOOK_SIGNING_KEY`
     - `GOOGLE_DRIVE_PICKER_REDIRECT_URI=https://shots.playbookmedia.io/app/google-drive-picker`
     - *(Leave `NANGO_API_BASE` unset to default to Nango Cloud `https://api.nango.dev`.)*
   - Deploy `founder-hub-api` (and pre-deploy migration job `founder-hub-api-migrate`) via `.github/workflows/api_cd.yaml` (with `API_DEPLOY_ENABLED=true`). DigitalOcean App Platform remains off.

---

## Step 4 — Pre-Verification & Google OAuth Review

1. **Finalize Legal Pages:** Have Playbook legal review and remove the draft banner on `apps/web/content/legal/privacy.mdx` and `terms.mdx` (the Google API Services User Data Policy Limited Use section is already included in `privacy.mdx`), then deploy `shots.playbookmedia.io`.
2. **Record Unlisted YouTube Demo Video:** Show the OAuth consent screen with the `client_id` visible in the browser URL bar, read-only Calendar sync, Drive OnePick folder selection + summary export, Meet transcript import, and disconnect/revocation.
3. **Submit `shots-founder-hub-prod` for Google Verification** (Sensitive scopes only; ~2–4 weeks review; $0 CASA fee).

---

## Step 5 — Verification

Run the automated verifier after provisioning and deployment:

```bash
./scripts/gcp/verify-gcp-runner.sh --env dev --skip-http
./scripts/gcp/verify-gcp-runner.sh --env prod
```

Then execute the manual OAuth smoke tests from the desktop app against Dev, then Prod:
- Google Calendar connect -> events load read-only -> `account_identity` populated.
- Google Drive connect -> **Choose Google Drive folder** (OnePick) -> summary automation runner exports Markdown & Google Docs -> mismatched-account & read-only folder rejected.
- Google Meet connect -> `account_identity` populated -> conference transcript import succeeds.
- Disconnect in app & revoke in `https://myaccount.google.com/connections` -> webhook updates `nango_connections`.

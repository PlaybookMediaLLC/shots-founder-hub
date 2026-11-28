#!/usr/bin/env bash
set -euo pipefail

# Provision Shots Founder Hub Google Cloud Console (Track A + Track B Runner) infrastructure.
#
# Usage:
#   ./scripts/gcp/provision-gcp-runner.sh --env dev|prod [options]
#
# Options:
#   --env <dev|prod>            Target environment (required). Maps to shots-founder-hub-<env>.
#   --project <PROJECT_ID>      Override default GCP project ID.
#   --org <ORG_ID>              GCP Organization ID (used only if project does not exist yet).
#   --billing-account <ID>      GCP Billing Account ID (optional; links billing when provided).
#   --region <REGION>           Artifact Registry / runner region (default: us-west1).
#   --skip-billing-resources    Provision OAuth APIs, IAM, and WIF only (skip billing-backed APIs/Artifact Registry).
#   --dry-run                   Print every gcloud command without executing it.
#   -h, --help                  Show this help message.

usage() {
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
}

ENV_NAME=""
PROJECT_ID=""
ORG_ID=""
BILLING_ACCOUNT=""
REGION="us-west1"
SKIP_BILLING_RESOURCES="false"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --org)
      ORG_ID="${2:-}"
      shift 2
      ;;
    --billing-account)
      BILLING_ACCOUNT="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --skip-billing-resources)
      SKIP_BILLING_RESOURCES="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$ENV_NAME" != "dev" && "$ENV_NAME" != "prod" ]]; then
  echo "Error: --env must be 'dev' or 'prod'." >&2
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="shots-founder-hub-${ENV_NAME}"
fi

if [[ ! "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Error: invalid GCP project ID '$PROJECT_ID'." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]] && ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI is not installed. Install Google Cloud SDK or rerun with --dry-run." >&2
  exit 1
fi

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] %q' "$1"
    shift
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
  else
    "$@"
  fi
}

# Track A: Required Google Workspace APIs (Nango + OnePick Drive runner).
# NOTE: gmail.googleapis.com is intentionally excluded to avoid CASA Tier 2 Restricted Scope audits.
TRACK_A_APIS=(
  "calendar-json.googleapis.com"
  "drive.googleapis.com"
  "meet.googleapis.com"
)

# Track B (no billing required): IAM, Workload Identity Federation, and Observability.
TRACK_B_CORE_APIS=(
  "iam.googleapis.com"
  "iamcredentials.googleapis.com"
  "sts.googleapis.com"
  "logging.googleapis.com"
  "monitoring.googleapis.com"
)

# Track B (requires linked billing account): Container Registry, Cloud Run, Compute, Secret Manager.
TRACK_B_BILLING_APIS=(
  "artifactregistry.googleapis.com"
  "run.googleapis.com"
  "compute.googleapis.com"
  "secretmanager.googleapis.com"
)

POOL_ID="github-actions-pool"
PROVIDER_ID="github-oidc"
REPO_NAME="shots-founder-hub"
GITHUB_OWNER="PlaybookMediaLLC"
ALLOWED_REPOS=(
  "PlaybookMediaLLC/shots-founder-hub"
  "PlaybookMediaLLC/shots"
)

DEPLOY_REF="refs/heads/develop"
ENV_LABEL="Dev"
if [[ "$ENV_NAME" == "prod" ]]; then
  DEPLOY_REF="refs/heads/main"
  ENV_LABEL="Prod"
fi

PROJECT_DISPLAY_NAME="Shots Founder Hub ${ENV_LABEL}"

echo "==> Provisioning Shots Founder Hub GCP (${ENV_NAME}) in project: ${PROJECT_ID} (region: ${REGION})"

# 1. Project creation (optional/idempotent) and billing link
if [[ "$DRY_RUN" == "true" ]]; then
  if [[ -n "$ORG_ID" ]]; then
    run_cmd gcloud projects create "$PROJECT_ID" --name="$PROJECT_DISPLAY_NAME" --organization="$ORG_ID"
  else
    run_cmd gcloud projects create "$PROJECT_ID" --name="$PROJECT_DISPLAY_NAME"
  fi
else
  if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
    if [[ -n "$ORG_ID" ]]; then
      run_cmd gcloud projects create "$PROJECT_ID" --name="$PROJECT_DISPLAY_NAME" --organization="$ORG_ID"
    else
      run_cmd gcloud projects create "$PROJECT_ID" --name="$PROJECT_DISPLAY_NAME"
    fi
  else
    echo "Project ${PROJECT_ID} already exists."
  fi
fi

# 2. Enable Track A (Google Workspace OAuth) + Track B Core (IAM/WIF) APIs
run_cmd gcloud services enable \
  "${TRACK_A_APIS[@]}" \
  "${TRACK_B_CORE_APIS[@]}" \
  --project="$PROJECT_ID"

# Ensure Gmail API stays disabled on the primary OAuth project
if [[ "$DRY_RUN" != "true" ]]; then
  if gcloud services list --enabled --project="$PROJECT_ID" --filter="config.name:gmail.googleapis.com" --format="value(config.name)" | grep -q "gmail.googleapis.com"; then
    echo "WARNING: gmail.googleapis.com is enabled on ${PROJECT_ID}. Disable it to prevent Restricted Scope CASA audit requirements." >&2
  fi
fi

# 3. Link billing and provision billing-backed Track B runner resources
if [[ "$SKIP_BILLING_RESOURCES" != "true" ]]; then
  if [[ -n "$BILLING_ACCOUNT" ]]; then
    run_cmd gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
  fi

  run_cmd gcloud services enable \
    "${TRACK_B_BILLING_APIS[@]}" \
    --project="$PROJECT_ID"

  if [[ "$DRY_RUN" == "true" ]]; then
    run_cmd gcloud artifacts repositories create "$REPO_NAME" \
      --project="$PROJECT_ID" \
      --repository-format=docker \
      --location="$REGION" \
      --description="Shots Founder Hub runner and service container images"
  else
    if ! gcloud artifacts repositories describe "$REPO_NAME" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
      run_cmd gcloud artifacts repositories create "$REPO_NAME" \
        --project="$PROJECT_ID" \
        --repository-format=docker \
        --location="$REGION" \
        --description="Shots Founder Hub runner and service container images"
    else
      echo "Artifact Registry repository ${REPO_NAME} already exists in ${REGION}."
    fi
  fi
else
  echo "Skipping billing-backed Track B APIs and Artifact Registry (--skip-billing-resources)."
fi

# 4. Least-privilege Service Accounts (keyless — no JSON keys created)
create_sa() {
  local sa_name="$1"
  local display_name="$2"
  local email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"
  if [[ "$DRY_RUN" == "true" ]]; then
    run_cmd gcloud iam service-accounts create "$sa_name" \
      --project="$PROJECT_ID" \
      --display-name="$display_name"
  elif ! gcloud iam service-accounts describe "$email" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run_cmd gcloud iam service-accounts create "$sa_name" \
      --project="$PROJECT_ID" \
      --display-name="$display_name"
  else
    echo "Service account ${email} already exists."
  fi
}

create_sa "sa-ci-runner" "Shots Founder Hub CI Runner (${ENV_NAME})"
create_sa "sa-deploy" "Shots Founder Hub Deployer (${ENV_NAME})"
create_sa "sa-api-runtime" "Shots Founder Hub API Runtime (${ENV_NAME})"
create_sa "sa-meet-worker" "Shots Founder Hub Meet Capture Worker (${ENV_NAME})"

SA_CI="sa-ci-runner@${PROJECT_ID}.iam.gserviceaccount.com"
SA_DEPLOY="sa-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
SA_API_RUNTIME="sa-api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SA_MEET="sa-meet-worker@${PROJECT_ID}.iam.gserviceaccount.com"

for role in roles/artifactregistry.writer roles/logging.logWriter roles/monitoring.metricWriter; do
  run_cmd gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_CI}" \
    --role="$role" \
    --condition=None
done

for role in roles/run.admin roles/secretmanager.admin roles/artifactregistry.reader roles/iam.serviceAccountUser; do
  run_cmd gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_DEPLOY}" \
    --role="$role" \
    --condition=None
done

for role in roles/secretmanager.secretAccessor roles/logging.logWriter roles/monitoring.metricWriter; do
  run_cmd gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_API_RUNTIME}" \
    --role="$role" \
    --condition=None
done

for role in roles/logging.logWriter roles/monitoring.metricWriter; do
  run_cmd gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_MEET}" \
    --role="$role" \
    --condition=None
done

# 5. Workload Identity Federation for GitHub Actions (keyless OIDC)
if [[ "$DRY_RUN" == "true" ]]; then
  run_cmd gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --display-name="GitHub Actions Pool"
else
  if ! gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
    run_cmd gcloud iam workload-identity-pools create "$POOL_ID" \
      --project="$PROJECT_ID" \
      --location=global \
      --display-name="GitHub Actions Pool"
  else
    echo "Workload Identity Pool ${POOL_ID} already exists."
  fi
fi

ATTRIBUTE_CONDITION="assertion.repository_owner == '${GITHUB_OWNER}' && (assertion.repository == 'PlaybookMediaLLC/shots-founder-hub' || assertion.repository == 'PlaybookMediaLLC/shots')"

if [[ "$DRY_RUN" == "true" ]]; then
  run_cmd gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub OIDC Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping='google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref,attribute.repo_env=has(assertion.environment) ? assertion.repository + ":" + assertion.environment : ""' \
    --attribute-condition="$ATTRIBUTE_CONDITION"
else
  if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
    run_cmd gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
      --project="$PROJECT_ID" \
      --location=global \
      --workload-identity-pool="$POOL_ID" \
      --display-name="GitHub OIDC Provider" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping='google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref,attribute.repo_env=has(assertion.environment) ? assertion.repository + ":" + assertion.environment : ""' \
      --attribute-condition="$ATTRIBUTE_CONDITION"
  else
    run_cmd gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
      --project="$PROJECT_ID" \
      --location=global \
      --workload-identity-pool="$POOL_ID" \
      --attribute-mapping='google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref,attribute.repo_env=has(assertion.environment) ? assertion.repository + ":" + assertion.environment : ""' \
      --attribute-condition="$ATTRIBUTE_CONDITION"
  fi
fi

PROJECT_NUMBER="<PROJECT_NUMBER>"
if [[ "$DRY_RUN" != "true" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
fi

WIF_BASE="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"

for repo in "${ALLOWED_REPOS[@]}"; do
  run_cmd gcloud iam service-accounts add-iam-policy-binding "$SA_CI" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="${WIF_BASE}/attribute.repository/${repo}"
done

run_cmd gcloud iam service-accounts add-iam-policy-binding "$SA_DEPLOY" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/repo:PlaybookMediaLLC/shots-founder-hub:ref:${DEPLOY_REF}"

if [[ "$ENV_NAME" == "prod" ]]; then
  run_cmd gcloud iam service-accounts add-iam-policy-binding "$SA_DEPLOY" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repo_env/PlaybookMediaLLC/shots-founder-hub:production"
fi

# 6. Print exact Google Auth Platform (OAuth Console) + Nango Cloud + Infisical checklist
cat <<EOF

===============================================================================
Manual Google Auth Platform Steps (${ENV_NAME}: ${PROJECT_ID})
===============================================================================
Google Auth Platform consent screen & external Web OAuth clients must be
configured in Google Cloud Console:
  https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}

1. Branding & Audience:
   - App name:           Shots Founder Hub$( [[ "$ENV_NAME" == "dev" ]] && echo " Dev" )
   - Support / Dev mail: team@playbookmedia.io
   - Homepage:           https://shots.playbookmedia.io
   - Privacy Policy:     https://shots.playbookmedia.io/privacy
   - Terms of Service:   https://shots.playbookmedia.io/terms
   - Authorized domain:  playbookmedia.io
   - Audience:           External ($( [[ "$ENV_NAME" == "dev" ]] && echo "Testing + explicit test users" || echo "In Production after Google verification" ))

2. Data Access (Scopes — do NOT add Gmail or full-drive scopes):
   - https://www.googleapis.com/auth/calendar.readonly
   - https://www.googleapis.com/auth/calendar.events.readonly
   - https://www.googleapis.com/auth/drive.file
   - https://www.googleapis.com/auth/meetings.space.readonly
   - openid
   - https://www.googleapis.com/auth/userinfo.email
   - https://www.googleapis.com/auth/userinfo.profile

3. Create 3 Separate Web Application OAuth 2.0 Clients:
EOF

if [[ "$ENV_NAME" == "prod" ]]; then
  cat <<'EOF'
   a) shots-founder-hub-calendar
      - JS Origins:    https://shots.playbookmedia.io
      - Redirect URIs: https://shots.playbookmedia.io/oauth/callback

   b) shots-founder-hub-drive  (BOTH redirect URIs required!)
      - JS Origins:    https://shots.playbookmedia.io
      - Redirect URIs: https://shots.playbookmedia.io/oauth/callback
                       https://shots.playbookmedia.io/app/google-drive-picker

   c) shots-founder-hub-meet
      - JS Origins:    https://shots.playbookmedia.io
      - Redirect URIs: https://shots.playbookmedia.io/oauth/callback

4. Nango Cloud (Production environment):
   - Custom Callback URL: https://shots.playbookmedia.io/oauth/callback
   - Webhook URL:         https://hub.usedante.app/nango/webhook
   - Providers:
       google-calendar -> shots-founder-hub-calendar (calendar.readonly, calendar.events.readonly)
       google-drive    -> shots-founder-hub-drive    (STRICTLY drive.file ONLY)
       google-meet     -> shots-founder-hub-meet     (meetings.space.readonly, openid, userinfo.email, userinfo.profile)

5. Infisical runtime secrets (Desktop App Backend -> prod -> /founder-hub):
   - NANGO_API_KEY=<nango-prod-secret-key>
   - NANGO_WEBHOOK_SIGNING_KEY=<nango-prod-webhook-signing-key>
   - GOOGLE_DRIVE_PICKER_REDIRECT_URI=https://shots.playbookmedia.io/app/google-drive-picker
EOF
else
  cat <<'EOF'
   a) shots-founder-hub-calendar
      - JS Origins:    http://localhost:3000
                       http://localhost:4400
      - Redirect URIs: https://api.nango.dev/oauth/callback

   b) shots-founder-hub-drive  (ALL redirect URIs required!)
      - JS Origins:    http://localhost:3000
                       http://localhost:4400
      - Redirect URIs: https://api.nango.dev/oauth/callback
                       http://localhost:3000/app/google-drive-picker
                       http://localhost:4400/app/google-drive-picker

   c) shots-founder-hub-meet
      - JS Origins:    http://localhost:3000
                       http://localhost:4400
      - Redirect URIs: https://api.nango.dev/oauth/callback

4. Nango Cloud (Dev environment):
   - Callback URL: https://api.nango.dev/oauth/callback
   - Providers:
       google-calendar -> shots-founder-hub-calendar (calendar.readonly, calendar.events.readonly)
       google-drive    -> shots-founder-hub-drive    (STRICTLY drive.file ONLY)
       google-meet     -> shots-founder-hub-meet     (meetings.space.readonly, openid, userinfo.email, userinfo.profile)

5. Local paired development (pnpm dev:local):
   - Export NANGO_API_KEY and NANGO_WEBHOOK_SIGNING_KEY before running pnpm dev:local up
   - GOOGLE_DRIVE_PICKER_REDIRECT_URI is automatically set to http://localhost:<web-port>/app/google-drive-picker
EOF
fi

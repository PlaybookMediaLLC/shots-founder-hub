#!/usr/bin/env bash
set -euo pipefail

# Verify Shots Founder Hub Google Cloud Console (Track A + Track B Runner) setup.
#
# Usage:
#   ./scripts/gcp/verify-gcp-runner.sh --env dev|prod [options]
#
# Options:
#   --env <dev|prod>           Target environment (required).
#   --project <PROJECT_ID>     Override default GCP project ID.
#   --region <REGION>          Artifact Registry region (default: us-west1).
#   --web-origin <URL>         Override web origin (default: https://shots.playbookmedia.io for prod).
#   --api-origin <URL>         Override API origin (default: https://founder-hub-api.shots.playbookmedia.io for prod).
#   --skip-billing-resources   Skip billing-backed API & Artifact Registry checks.
#   --skip-gcp                 Skip gcloud API / WIF / Artifact Registry checks.
#   --skip-http                Skip live HTTP endpoint checks.
#   -h, --help                 Show this help message.

usage() {
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
}

ENV_NAME=""
PROJECT_ID=""
REGION="us-west1"
WEB_ORIGIN=""
API_ORIGIN=""
SKIP_BILLING_RESOURCES="false"
SKIP_GCP="false"
SKIP_HTTP="false"

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
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --web-origin)
      WEB_ORIGIN="${2:-}"
      shift 2
      ;;
    --api-origin)
      API_ORIGIN="${2:-}"
      shift 2
      ;;
    --skip-billing-resources)
      SKIP_BILLING_RESOURCES="true"
      shift
      ;;
    --skip-gcp)
      SKIP_GCP="true"
      shift
      ;;
    --skip-http)
      SKIP_HTTP="true"
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

PROJECT_ID="${PROJECT_ID:-shots-founder-hub-${ENV_NAME}}"
if [[ -z "$WEB_ORIGIN" ]]; then
  if [[ "$ENV_NAME" == "prod" ]]; then
    WEB_ORIGIN="https://shots.playbookmedia.io"
  else
    WEB_ORIGIN="http://localhost:4400"
  fi
fi
if [[ -z "$API_ORIGIN" ]]; then
  if [[ "$ENV_NAME" == "prod" ]]; then
    API_ORIGIN="https://founder-hub-api.shots.playbookmedia.io"
  else
    API_ORIGIN="http://localhost:4408"
  fi
fi

failures=0
pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*" >&2; failures=$((failures + 1)); }

if [[ "$SKIP_GCP" != "true" ]]; then
  if ! command -v gcloud >/dev/null 2>&1; then
    fail "gcloud CLI is not installed (pass --skip-gcp to run HTTP checks only)"
  else
    echo "==> Checking GCP project ${PROJECT_ID}"
    enabled_services="$(gcloud services list --enabled --project="$PROJECT_ID" --format="value(config.name)")"
    required_services=(
      calendar-json.googleapis.com
      drive.googleapis.com
      meet.googleapis.com
      iam.googleapis.com
      iamcredentials.googleapis.com
      sts.googleapis.com
      logging.googleapis.com
      monitoring.googleapis.com
    )
    if [[ "$SKIP_BILLING_RESOURCES" != "true" ]]; then
      required_services+=(
        artifactregistry.googleapis.com
        run.googleapis.com
        compute.googleapis.com
        secretmanager.googleapis.com
      )
    fi
    for svc in "${required_services[@]}"; do
      if grep -qx "$svc" <<<"$enabled_services"; then
        pass "API enabled: ${svc}"
      else
        fail "API missing: ${svc}"
      fi
    done

    if grep -qx "gmail.googleapis.com" <<<"$enabled_services"; then
      fail "gmail.googleapis.com is enabled on ${PROJECT_ID} (must remain excluded to avoid CASA Tier 2 audit)"
    else
      pass "gmail.googleapis.com is disabled"
    fi

    if gcloud iam workload-identity-pools providers describe github-oidc \
      --project="$PROJECT_ID" --location=global --workload-identity-pool=github-actions-pool >/dev/null 2>&1; then
      pass "Workload Identity Provider github-actions-pool/github-oidc exists"
    else
      fail "Workload Identity Provider github-actions-pool/github-oidc missing"
    fi

    for sa in sa-ci-runner sa-deploy sa-meet-worker; do
      email="${sa}@${PROJECT_ID}.iam.gserviceaccount.com"
      if gcloud iam service-accounts describe "$email" --project="$PROJECT_ID" >/dev/null 2>&1; then
        pass "Service account exists: ${email}"
      else
        fail "Service account missing: ${email}"
      fi
    done

    if [[ "$SKIP_BILLING_RESOURCES" != "true" ]]; then
      if gcloud artifacts repositories describe shots-founder-hub \
        --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
        pass "Artifact Registry repository shots-founder-hub exists in ${REGION}"
      else
        fail "Artifact Registry repository shots-founder-hub missing in ${REGION}"
      fi
    fi
  fi
fi

if [[ "$SKIP_HTTP" != "true" ]]; then
  echo "==> Checking HTTP endpoints (${WEB_ORIGIN}, ${API_ORIGIN})"

  callback_headers="$(curl -sS -D - -o /dev/null --max-time 10 "${WEB_ORIGIN}/oauth/callback?code=smoke&state=smoke" || true)"
  if grep -qE '^HTTP/[0-9.]+ 308' <<<"$callback_headers" \
    && grep -qi '^location: https://api\.nango\.dev/oauth/callback\?code=smoke&state=smoke' <<<"$callback_headers" \
    && grep -qi '^cache-control:.*no-store' <<<"$callback_headers"; then
    pass "${WEB_ORIGIN}/oauth/callback returns 308 -> Nango Cloud with Cache-Control: no-store"
  else
    fail "${WEB_ORIGIN}/oauth/callback did not return expected 308 redirect to Nango Cloud"
  fi

  for legal_path in /privacy /terms; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${WEB_ORIGIN}${legal_path}" || echo "000")"
    if [[ "$code" == "200" ]]; then
      pass "${WEB_ORIGIN}${legal_path} returned HTTP 200"
    else
      fail "${WEB_ORIGIN}${legal_path} returned HTTP ${code} (expected 200)"
    fi
  done

  core_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${API_ORIGIN}/health/ready/core" || echo "000")"
  if [[ "$core_status" == "200" ]]; then
    pass "${API_ORIGIN}/health/ready/core returned HTTP 200"
  else
    fail "${API_ORIGIN}/health/ready/core returned HTTP ${core_status} (expected 200)"
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Verification failed with ${failures} issue(s)." >&2
  exit 1
fi

echo "All checked GCP Runner gates passed."

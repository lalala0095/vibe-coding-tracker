#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Vibe Coding Tracker — Cloud Run deployment script
# Uses gcloud CLI for authentication (no service account key file needed).
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated:  gcloud auth login
#   2. Docker / Cloud Build access on your project
#   3. A .env.deploy file (copy from .env.deploy.example and fill in values)
#
# Usage:
#   ./deploy.sh              # uses .env.deploy for config
#   ./deploy.sh --help       # show help
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

# ---- Defaults (overridden by .env.deploy) ---------------------------------
SERVICE_NAME="vibe-coding-tracker-api"
REGION="asia-southeast1"
GOOGLE_CLOUD_PROJECT=""
GOOGLE_CLIENT_ID=""
SECRET_KEY=""
SESSION_EXPIRY_DAYS="7"
FIRESTORE_DATABASE="(default)"
GCS_BUCKET_NAME=""
CORS_ORIGINS=""
MIN_INSTANCES=0
MAX_INSTANCES=10
MEMORY="512Mi"
CPU="1"

# ---- Help ------------------------------------------------------------------
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
Usage: ./deploy.sh [--help]

Deploys the FastAPI backend to Google Cloud Run using gcloud CLI credentials.

Configuration is read from .env.deploy (copy .env.deploy.example and edit it).

Steps performed:
  1. Validate gcloud is authenticated
  2. Set the active gcloud project
  3. Enable required GCP APIs (if not already enabled)
  4. Build and push the container image via Cloud Build
  5. Deploy to Cloud Run with env vars from .env.deploy
  6. Print the service URL

EOF
  exit 0
fi

# ---- Load .env.deploy ------------------------------------------------------
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found."
  echo "Copy .env.deploy.example to .env.deploy and fill in your values."
  exit 1
fi

echo "Loading config from ${ENV_FILE}..."
# shellcheck disable=SC1090
source "${ENV_FILE}"

# ---- Validate required vars ------------------------------------------------
missing=()
[[ -z "${GOOGLE_CLOUD_PROJECT}" ]] && missing+=("GOOGLE_CLOUD_PROJECT")
[[ -z "${GOOGLE_CLIENT_ID}" ]]     && missing+=("GOOGLE_CLIENT_ID")
[[ -z "${SECRET_KEY}" ]]           && missing+=("SECRET_KEY")
[[ -z "${GCS_BUCKET_NAME}" ]]      && missing+=("GCS_BUCKET_NAME")
[[ -z "${CORS_ORIGINS}" ]]         && missing+=("CORS_ORIGINS")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: The following required variables are not set in ${ENV_FILE}:"
  for var in "${missing[@]}"; do echo "  - ${var}"; done
  exit 1
fi

# ---- Check gcloud auth -----------------------------------------------------
echo ""
echo "Checking gcloud authentication..."
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  echo "ERROR: No active gcloud account found."
  echo "Run:  gcloud auth login"
  exit 1
fi
echo "  Authenticated as: ${ACTIVE_ACCOUNT}"

# ---- Set project ------------------------------------------------------------
echo ""
echo "Setting project to: ${GOOGLE_CLOUD_PROJECT}"
gcloud config set project "${GOOGLE_CLOUD_PROJECT}" --quiet

# ---- Enable required APIs --------------------------------------------------
echo ""
echo "Enabling required GCP APIs (this may take a moment if not already enabled)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  --quiet

# ---- Build & push via Cloud Build ------------------------------------------
IMAGE="gcr.io/${GOOGLE_CLOUD_PROJECT}/${SERVICE_NAME}"
echo ""
echo "Building container image via Cloud Build..."
echo "  Image: ${IMAGE}"
gcloud builds submit "${SCRIPT_DIR}" \
  --tag "${IMAGE}" \
  --quiet

# ---- Deploy to Cloud Run ---------------------------------------------------
echo ""
echo "Deploying to Cloud Run..."
echo "  Service : ${SERVICE_NAME}"
echo "  Region  : ${REGION}"
echo "  Image   : ${IMAGE}"
echo "  Memory  : ${MEMORY}"
echo "  CPU     : ${CPU}"

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --memory "${MEMORY}" \
  --cpu "${CPU}" \
  --min-instances "${MIN_INSTANCES}" \
  --max-instances "${MAX_INSTANCES}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},SECRET_KEY=${SECRET_KEY},SESSION_EXPIRY_DAYS=${SESSION_EXPIRY_DAYS},FIRESTORE_DATABASE=${FIRESTORE_DATABASE},GCS_BUCKET_NAME=${GCS_BUCKET_NAME},CORS_ORIGINS=${CORS_ORIGINS}" \
  --quiet

# ---- Print service URL -----------------------------------------------------
echo ""
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format "value(status.url)")

echo "================================================================"
echo "  Deployment complete!"
echo "  Service URL : ${SERVICE_URL}"
echo "  Health check: ${SERVICE_URL}/health"
echo "================================================================"

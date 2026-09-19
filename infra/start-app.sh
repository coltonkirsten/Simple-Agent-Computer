#!/bin/bash
# Runs on the VM as the systemd service "sac-app" (see cloud-init.yaml.tftpl).
# Fetches secrets, pulls the image, then runs the app container in the
# foreground so systemd supervises it and restarts it if it dies.
#
# Container-Optimized OS has no gcloud, jq or python, so this uses only curl,
# sed and base64.
set -euo pipefail

# Non-secret settings written by cloud-init from Terraform values:
# PROJECT_ID, REGISTRY_HOST, IMAGE, BASE_URL
# shellcheck source=/dev/null  (the file only exists on the VM)
source /etc/sac/config.env

METADATA="http://metadata.google.internal/computeMetadata/v1"

# --- 1. Who am I? -------------------------------------------------------------
# Every GCP VM can ask the metadata server (a link-local address only the VM
# itself can reach) for a short-lived OAuth token for its service account.
# This is why no key file or password exists anywhere on this machine.
TOKEN=$(curl -sf -H "Metadata-Flavor: Google" \
  "$METADATA/instance/service-accounts/default/token" |
  sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')

# --- 2. Fetch secrets -----------------------------------------------------------
# The service account may read exactly four secrets (infra/secrets.tf).
fetch_secret() {
  local payload
  payload=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT_ID/secrets/$1/versions/latest:access") || {
    echo "ERROR: cannot read secret '$1'. Has a version been added? (gcloud secrets versions add $1 --data-file=-)" >&2
    exit 1
  }
  # Response is JSON: {"payload": {"data": "<base64>"}}. Strip any newline a
  # careless `echo` may have stored; it would corrupt the env file.
  echo "$payload" | sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p' | base64 -d | tr -d '\r\n'
}

# /run is a tmpfs: secrets live in RAM only and vanish on shutdown. Mode 600
# root — the app container runs as uid 65532 and cannot read this file, even
# though it can see the host filesystem.
#
# Each secret is assigned to a variable first: `set -e` aborts on a failed
# plain assignment, but would NOT notice a failure buried inside a heredoc.
CLIENT_ID=$(fetch_secret oauth-client-id)
CLIENT_SECRET=$(fetch_secret oauth-client-secret)
SESSION_SECRET=$(fetch_secret session-secret)
ALLOWED_EMAILS=$(fetch_secret allowed-emails)

umask 077
mkdir -p /run/sac
cat >/run/sac/app.env <<EOF
GOOGLE_CLIENT_ID=$CLIENT_ID
GOOGLE_CLIENT_SECRET=$CLIENT_SECRET
SESSION_SECRET=$SESSION_SECRET
ALLOWED_EMAILS=$ALLOWED_EMAILS
EOF

# Production mode (Secure "__Host-" cookies, trust one proxy hop) whenever
# we're served over https. The app refuses to start in production over http.
NODE_ENV=development
if [[ "$BASE_URL" == https://* ]]; then NODE_ENV=production; fi

# --- 3. Pull the image ------------------------------------------------------------
# docker-credential-gcr (preinstalled on COS) teaches docker to authenticate
# to Artifact Registry with the same metadata-server token.
docker-credential-gcr configure-docker --registries="$REGISTRY_HOST"
docker pull "$IMAGE"
docker rm -f sac-app 2>/dev/null || true

# --- 4. Run -----------------------------------------------------------------------
#   -v /:/host:ro              the VM's filesystem, READ-ONLY, is what we browse
#   --read-only                the container's own filesystem is immutable
#   --tmpfs /tmp               ...except a scratch dir in RAM
#   --cap-drop=ALL             drop every Linux capability (no raw sockets,
#                              no chown, no mount, ...). The app needs none.
#   --security-opt=no-new-privileges   setuid binaries can't escalate
#   --pids-limit / --memory    a runaway or hostile process can't starve the VM
#   --network sac-net          private docker network shared with Caddy. Note
#                              there is NO -p flag: the app publishes no port
#                              on the VM at all. The only way in is via Caddy.
#
# `exec` replaces this shell with docker, so systemd tracks the real process.
exec docker run --rm --name sac-app \
  --env-file /run/sac/app.env \
  -e NODE_ENV="$NODE_ENV" \
  -e BASE_URL="$BASE_URL" \
  -e FILE_ROOT=/host \
  -v /:/host:ro \
  --read-only \
  --tmpfs /tmp \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=100 \
  --memory=512m \
  --network sac-net \
  "$IMAGE"

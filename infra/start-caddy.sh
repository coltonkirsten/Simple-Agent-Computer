#!/bin/bash
# Runs on the VM as the systemd service "sac-caddy" (see cloud-init.yaml.tftpl).
set -euo pipefail

# Pinned by digest, like the app's base images. Bump deliberately.
CADDY_IMAGE="caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e"

docker pull "$CADDY_IMAGE"
docker rm -f sac-caddy 2>/dev/null || true

#   -p 80:80 -p 443:443        the ONLY ports published on this VM
#   -v /var/lib/caddy:/data    certificates + private keys. /var/lib survives
#                              reboots on COS. This matters: Let's Encrypt
#                              rate-limits issuance (5 identical certs/week), so
#                              re-requesting one on every boot would lock us out.
#                              (The file explorer deny-lists /var/lib/caddy.)
#   --cap-add=NET_BIND_SERVICE the one capability needed: binding ports < 1024
exec docker run --rm --name sac-caddy \
  --network sac-net \
  -p 80:80 \
  -p 443:443 \
  -v /var/lib/caddy:/data \
  -v /etc/sac/Caddyfile:/etc/caddy/Caddyfile:ro \
  --read-only \
  --tmpfs /config \
  --tmpfs /tmp \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --security-opt=no-new-privileges \
  --pids-limit=100 \
  --memory=128m \
  "$CADDY_IMAGE"

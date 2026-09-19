# syntax=docker/dockerfile:1
#
# Multi-stage build: compilers, dev dependencies and source stay in throwaway
# stages. Only what's needed at runtime reaches the final image.
#
# Base images are pinned by DIGEST (@sha256:...), not just by tag. A tag like
# "22-bookworm-slim" can be re-pointed at different contents at any time; a
# digest is the hash of the exact bytes. Dependabot opens PRs to bump them.

# --- Stage 1: compile TypeScript → dist/ ---------------------------------------
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /app
# Copy the manifests first: Docker caches each layer, so `npm ci` only re-runs
# when dependencies change, not on every source edit.
COPY package.json package-lock.json ./
# `npm ci` installs exactly what the lockfile says and fails if it's out of sync.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: production-only node_modules (no typescript, vitest, eslint...) ---
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 3: the image that actually ships --------------------------------------
# Distroless = Node and its runtime libraries, nothing else. No shell, no
# package manager, no curl: if an attacker got code execution there is almost
# nothing to work with. The ":nonroot" variant runs as uid 65532.
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./

# Inside a container "localhost" is the container itself, so the app must
# listen on all interfaces to be reachable through the published port.
ENV HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

# No curl in distroless, so the health check is a one-line Node script.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The distroless entrypoint is already `node`.
CMD ["dist/server.js"]

# Simple Agent Computer

A single GCP e2-micro VM serving a web page behind Google login. Only
allowlisted accounts get in; once in, you can browse the VM's file tree
(read-only).

It's also a learning project: the goal is to build it the *proper* way —
Terraform for infrastructure, GitHub Actions for CI/CD, keyless auth to GCP,
and security best practices throughout.

**📍 The plan lives in [NORTH_STAR.md](NORTH_STAR.md).** It's broken into small
phases, each landing as one pull request.

## Operating it

- **[docs/runbook.md](docs/runbook.md)** — change the allowlist, rotate secrets, roll back, read the audit log, debug an outage, tear down
- **[SECURITY.md](SECURITY.md)** — the security model, layer by layer, and its known limits
- [infra/README.md](infra/README.md) — how changes reach production

## Layout

| Path | What |
|---|---|
| `app/` | Node + TypeScript web app *(from Phase 5)* |
| `infra/` | Terraform *(from Phase 3)* |
| `.github/workflows/` | CI/CD *(from Phase 9)* |
| `docs/` | Bootstrap notes and runbook |

## Getting set up

```sh
brew install pre-commit hashicorp/tap/terraform
pre-commit install          # enable the git hooks in this clone
pre-commit run --all-files  # check everything once
```

## Ground rules

- `main` is protected — all changes go through a pull request.
- No secrets in git. No service account keys, anywhere.

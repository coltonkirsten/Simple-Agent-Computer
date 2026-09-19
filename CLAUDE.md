# CLAUDE.md

Instructions for AI agents working in this repo.

## The plan

`NORTH_STAR.md` is the source of truth. Work one phase at a time, in order.
Use the phase's **🤖 Agent** block as the spec; don't build ahead into later phases.

## Workflow

- One phase = one branch (`phase-N-short-name`) = one PR. Never commit to `main`.
- Keep diffs readable: the owner is learning and reads every diff. Prefer
  plain, well-commented code over clever abstractions. Comments should explain
  *why*, especially for security or GCP-specific choices.
- When a phase merges, tick its checkbox in `NORTH_STAR.md` in the next PR.
- Things only the owner can do (console clicks, billing, secret values,
  `terraform apply`) go in the PR description as a checklist — don't attempt them.

## Hard rules

- No secrets in git: no `.env`, no `*.tfvars`, no OAuth secrets, no tokens.
- No service account JSON keys, ever. CI authenticates via Workload Identity Federation.
- Secret *values* never go through Terraform (they'd land in state). Terraform
  creates the Secret Manager containers; the owner adds versions with `gcloud`.
- Never run `terraform apply` or `terraform destroy`. `fmt`, `validate` and `plan` are fine.
- The file explorer is read-only. Do not add write/exec endpoints.
- All filesystem access in the app goes through the single `safeResolve()` path guard.
- Pin versions: Terraform providers, Docker base images, and GitHub Actions (by commit SHA).

## Layout

```
app/                 Node 22 + TypeScript + Express web app
infra/               Terraform (flat, no modules)
.github/workflows/   CI/CD
docs/                bootstrap notes, runbook
```

## Commands

- Hooks: `pre-commit run --all-files`
- App (from Phase 5): `cd app && npm test && npm run lint`
- Infra (from Phase 3): `cd infra && terraform fmt -check && terraform validate`

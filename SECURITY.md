# Security

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. You'll get a reply
within a few days. This is a personal learning project with no bounty, but
reports are genuinely appreciated and will be credited if you'd like.

## What this project is protecting

A web app that lets a short allowlist of Google accounts browse — read-only —
the filesystem of the VM it runs on. The things worth defending:

1. **Who gets in.** Only allowlisted, Google-verified emails.
2. **What they can reach.** Nothing outside the mounted root; nothing on the deny-list; never write or execute.
3. **The cloud project behind it.** No credential that could be stolen from the repo, CI, or the VM's disk.

## How it's defended (and where to look)

| Layer | Control | Where |
|---|---|---|
| Identity | OIDC authorization-code flow with PKCE, `state`, `nonce`; ID token verified by a certified library | `app/src/identity.ts` |
| Authorization | Email allowlist, `email_verified` required, **re-checked on every request** | `app/src/auth.ts` |
| Sessions | Encrypted stateless cookie; `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix; 8 h expiry sealed inside | `app/src/session.ts` |
| CSRF / redirects | POST + token for logout; open-redirect guard on post-login destination | `app/src/auth.ts` |
| Path traversal | Single choke point: lexical check, then `realpath` check, then deny-list on the resolved path | `app/src/paths.ts` |
| Read-only | No write/exec routes exist; host mounted `:ro`; container filesystem read-only | `app/src/app.ts`, `infra/start-app.sh` |
| XSS | All output escaped; CSP `default-src 'none'`, no scripts allowed at all | `app/src/views.ts`, `app/src/app.ts` |
| Container | Distroless, non-root, all capabilities dropped, `no-new-privileges`, memory/pid limits | `app/Dockerfile`, `infra/start-app.sh` |
| Network | Only 80/443 public; SSH only via IAP; app publishes no host port — Caddy is the sole listener | `infra/network.tf`, `infra/start-caddy.sh` |
| Transport | Automatic Let's Encrypt TLS, HSTS | `infra/Caddyfile.tftpl` |
| Secrets | Secret Manager; values never in git or Terraform state; on the VM only in a root-only tmpfs file | `infra/secrets.tf`, `infra/start-app.sh` |
| Cloud identity | No service account keys anywhere. VM uses the metadata server; CI uses Workload Identity Federation locked to this repo's ID, deploy identity to `main` only | `infra/iam.tf`, `infra/wif.tf` |
| Supply chain | Actions pinned to commit SHAs, base images pinned by digest, lockfile installs, Dependabot, Trivy + `npm audit` + gitleaks in CI | `.github/` |
| Change control | Protected `main`, required CI, plan-on-PR, manual approval to deploy | repo settings, `.github/workflows/` |
| Detection | JSON audit log of logins, views and denials shipped off the VM; uptime alerting | `app/src/log.ts`, `infra/monitoring.tf` |

## Known limitations (accepted, on purpose)

- **Sessions can't be revoked individually.** They're stateless. Mitigation:
  removing an email from the allowlist locks that user out on their next
  request; rotating `session-secret` logs everyone out.
- **The VM has a public IP** instead of sitting behind a load balancer (cost).
- **The CI deploy identity is effectively a project admin**, because it
  applies Terraform that manages IAM. It's protected by the main-only WIF
  binding, branch protection, and the deployment approval — not by its role list.
- **Allowlisted users can read any world-readable file on the VM** that isn't
  deny-listed. The deny-list is a second layer, not a guarantee that nothing
  sensitive is world-readable. Treat an allowlist entry as real trust.
- **Single VM, no redundancy.** Deploys cause ~2 minutes of downtime.

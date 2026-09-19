# North Star — Simple Agent Computer

> One e2-micro VM on GCP. A web page behind Google login. Only allowlisted
> users get in. Once in, you can browse the VM's file tree (read-only).
> Everything is built the "proper" way: Terraform, CI/CD, no long-lived keys.

This doc is the single source of truth for the plan. Work through it top to
bottom. Each phase is small, ends in something you can see working, and lands
as **one pull request** so the diff is readable.

## How to use this doc

Each phase has four parts:

- **Learn** — the concepts this phase teaches. Read these before looking at the diff.
- **👤 Human** — things only you can do (console clicks, billing, secrets, approvals).
- **🤖 Agent** — the prompt-ready instructions for Claude to write the code.
- **✅ Done when** — a concrete check. Don't move on until it passes.

Rules of the road:

1. One phase = one branch = one PR. Branch name: `phase-N-short-name`.
2. The agent writes code; you read the diff and merge. If you can't explain a
   file in the diff, ask before merging.
3. No secrets in git, ever. No service account JSON keys, ever.
4. Tick the checkbox in [Progress](#progress) when a phase merges.

## Progress

- [x] Phase 0 — Local tooling
- [x] Phase 1 — Repo hygiene
- [x] Phase 2 — GCP project bootstrap
- [x] Phase 3 — Terraform skeleton + remote state
- [ ] Phase 4 — Network + VM
- [ ] Phase 5 — App v0: file explorer (local, no auth)
- [ ] Phase 6 — Google login + allowlist
- [ ] Phase 7 — Containerize + run on the VM
- [ ] Phase 8 — Domain + HTTPS
- [ ] Phase 9 — CI (checks on every PR)
- [ ] Phase 10 — CD (keyless deploys from GitHub)
- [ ] Phase 11 — Hardening + operations

---

## Target architecture

```
  Browser ──HTTPS──▶ [ e2-micro VM, Container-Optimized OS ]
                        ├─ caddy container  (TLS certs, reverse proxy :443 → app)
                        └─ app container    (Node/TS: Google OIDC login,
                                             allowlist check, file-tree API + UI)
                                             host "/" mounted READ-ONLY at /host

  GitHub Actions ──OIDC (Workload Identity Federation, no keys)──▶ GCP
     ├─ PR:    lint, test, terraform plan, security scans
     └─ main:  terraform apply, build image → Artifact Registry → restart on VM

  Terraform state ─▶ GCS bucket (versioned)
  Secrets         ─▶ Secret Manager (OAuth client secret, session key, allowlist)
  SSH             ─▶ only via IAP tunnel (port 22 closed to the internet)
```

### Key decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Auth | App-level Google OIDC + email allowlist | Google's managed option (IAP) needs an HTTPS load balancer (~$18/mo). Doing OIDC in the app is free and teaches you how login actually works. |
| Allowlist | Comma-separated emails in Secret Manager | Keeps emails out of a public repo; changing who has access doesn't require a code change. |
| App stack | Node 22 + TypeScript + Express, server-rendered UI | Already installed locally; small enough to read end to end. |
| Runtime | Docker on Container-Optimized OS | Locked-down, auto-updating OS; deploys become "pull new image". |
| TLS | Caddy with automatic Let's Encrypt | Google OAuth requires HTTPS redirect URIs. Caddy makes it ~5 lines of config. |
| CI → GCP auth | Workload Identity Federation | No JSON keys to leak. This is *the* current best practice. |
| Region | `us-central1` (or `us-west1` / `us-east1`) | e2-micro free tier only applies in these regions. |

### Cost expectations

e2-micro + 30 GB standard disk + the external IP on a running VM fall in the
free tier in the regions above. Artifact Registry (0.5 GB free), Secret Manager
(6 secrets free) and GCS state (pennies) are negligible. The only real spend
is a domain (~$10–12/yr). Phase 2 sets a **$5 budget alert** so nothing can
surprise you.

### Security baseline (applies to every phase)

- Least privilege: the VM runs as its own service account with only the roles it needs.
- Firewall: only 80/443 open to the world. SSH only through IAP.
- File explorer is **read-only**, resolves real paths to block `../` and symlink
  escapes, and hides sensitive paths (`/proc`, `/sys`, `/dev`, docker secrets).
- Container runs as non-root, read-only root filesystem, no extra capabilities.
- Sessions: `HttpOnly`, `Secure`, `SameSite=Lax` cookies; OIDC `state` + `nonce` + PKCE.
- `main` is protected; everything goes through a PR with passing checks.

---

## Phase 0 — Local tooling

**Learn:** what each CLI is for: `gcloud` (talk to GCP), `terraform`
(declare infrastructure), `gh` (talk to GitHub), `docker` (build/run images).

**👤 Human**
1. Install Terraform: `brew tap hashicorp/tap && brew install hashicorp/tap/terraform`
2. Update gcloud: `gcloud components update`
3. Install pre-commit: `brew install pre-commit`
4. Confirm: `terraform version && gcloud version && gh auth status && docker version`

**🤖 Agent:** nothing.

**✅ Done when:** all four commands print versions without errors.

---

## Phase 1 — Repo hygiene

**Learn:** branch protection, why `.gitignore` matters for Terraform
(`*.tfstate` and `*.tfvars` can contain secrets), pre-commit hooks, secret scanning.

**🤖 Agent**
> Create branch `phase-1-repo-hygiene`. Add: a `.gitignore` covering Node,
> Terraform (`.terraform/`, `*.tfstate*`, `*.tfvars` except `*.tfvars.example`),
> `.env*`, and macOS files; a real `README.md` (what this is, link to
> NORTH_STAR.md); `.editorconfig`; `.pre-commit-config.yaml` with gitleaks,
> `terraform_fmt`, trailing-whitespace and end-of-file fixers;
> `.github/dependabot.yml` for npm, terraform, docker and github-actions;
> a `CLAUDE.md` stating the repo rules (one phase per PR, no secrets, no SA keys,
> follow NORTH_STAR.md). Planned layout: `app/`, `infra/`, `.github/workflows/`,
> `docs/`. Open a PR.

**👤 Human**
1. Run `pre-commit install` in the repo.
2. Read the PR diff, merge it.
3. GitHub → Settings → Branches → add a ruleset for `main`: require a pull
   request, block force pushes. (You'll add "require status checks" in Phase 9.)
4. GitHub → Settings → Code security: enable secret scanning + push protection
   and Dependabot alerts.

**✅ Done when:** pushing directly to `main` is rejected, and
`pre-commit run --all-files` passes.

---

## Phase 2 — GCP project bootstrap

**Learn:** the GCP resource hierarchy (account → project → resources), billing
accounts, why APIs must be enabled per project, Application Default Credentials.
This is the one phase that's deliberately manual — it's the chicken-and-egg
step before Terraform can manage anything.

**👤 Human**
1. Console → create a new project. Pick an ID like `simple-agent-computer-<random>`
   (IDs are global and permanent). Link your billing account.
2. **Billing → Budgets & alerts → create a $5 budget** with alerts at 50/90/100%.
   Do this before anything else.
3. Locally:
   ```sh
   gcloud auth login
   gcloud config set project <PROJECT_ID>
   gcloud auth application-default login   # credentials Terraform will use
   ```
4. Create the Terraform state bucket (the one resource Terraform can't create
   for itself):
   ```sh
   gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
     --location=us-central1 --uniform-bucket-level-access \
     --public-access-prevention
   gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
   ```

**🤖 Agent**
> Add `docs/bootstrap.md` recording exactly the manual steps above (with
> placeholders, no real IDs required to be secret but keep them in variables),
> so the project could be recreated from scratch.

**✅ Done when:** `gcloud config get project` shows your project and
`gcloud storage ls` shows the tfstate bucket.

---

## Phase 3 — Terraform skeleton + remote state

**Learn:** providers, the `init → plan → apply` loop, remote state and locking,
variables vs. tfvars, why you pin versions.

**🤖 Agent**
> Branch `phase-3-terraform-skeleton`. In `infra/` create: `versions.tf`
> (pinned terraform + google provider), `backend.tf` (GCS backend, bucket passed
> via `-backend-config`), `variables.tf` (`project_id`, `region`, `zone`),
> `terraform.tfvars.example`, `apis.tf` enabling compute, iam, iamcredentials,
> iap, secretmanager, artifactregistry, cloudresourcemanager, logging and
> monitoring APIs with `disable_on_destroy = false`, and `outputs.tf`. Add
> `infra/README.md` explaining each file and the init/plan/apply commands.
> Keep it flat — no modules yet.

**👤 Human**
1. Copy `terraform.tfvars.example` → `terraform.tfvars`, fill in your values.
2. `cd infra && terraform init -backend-config="bucket=<PROJECT_ID>-tfstate"`
3. `terraform plan` — **read it**. Then `terraform apply`.

**✅ Done when:** apply succeeds, and a second `terraform plan` says
"No changes." (That idempotency is the whole point of Terraform.)

---

## Phase 4 — Network + VM

**Learn:** VPCs and subnets, firewall rules and network tags, service accounts
as VM identities, IAP TCP forwarding (SSH with no open port 22), OS Login,
Shielded VM.

**🤖 Agent**
> Branch `phase-4-network-vm`. Add to `infra/`: `network.tf` (custom-mode VPC,
> one subnet, firewall rules: allow 80/443 from anywhere to tag `web`; allow 22
> only from the IAP range `35.235.240.0/20`), `iam.tf` (dedicated VM service
> account with only logging.logWriter, monitoring.metricWriter,
> artifactregistry.reader; IAP tunnel + OS Login roles for a `admin_email`
> variable), `vm.tf` (e2-micro, Container-Optimized OS, 30 GB pd-standard,
> shielded VM on, OS Login on, project-wide SSH keys blocked, static external
> IP, tag `web`). Output the IP and a ready-to-paste IAP ssh command. No
> startup script yet.

**👤 Human**
1. `terraform plan`, read it, `terraform apply`.
2. SSH in: `gcloud compute ssh <vm-name> --zone <zone> --tunnel-through-iap`
3. Look around — this is the filesystem your app will eventually show.
4. Prove port 22 is closed publicly: `nc -vz <EXTERNAL_IP> 22` should time out.

**✅ Done when:** IAP SSH works and direct SSH doesn't.

---

## Phase 5 — App v0: file explorer (local, no auth)

**Learn:** the core app logic in isolation, and the #1 vulnerability of any
file browser — **path traversal** — and how to defeat it.

**🤖 Agent**
> Branch `phase-5-app-v0`. In `app/` create a Node 22 + TypeScript + Express
> app. `FILE_ROOT` env var sets the browsable root (default `.`).
> `GET /api/tree?path=` returns directory entries (name, type, size, mtime);
> `GET /api/file?path=` returns text file contents capped at 1 MB, refusing
> binaries. All path handling goes through one `safeResolve()` function that
> uses `fs.realpath` and verifies the result is inside `FILE_ROOT`, plus a
> denylist (`/proc`, `/sys`, `/dev`, `/var/lib/docker`, anything under
> `/etc/shadow`-style sensitive files). A minimal server-rendered UI: breadcrumb,
> directory listing, file viewer. No write endpoints at all. Add helmet,
> ESLint, Prettier, and Vitest tests — especially for `safeResolve` against
> `../`, absolute paths, URL-encoded traversal, and symlinks escaping the root.
> Bind to localhost only. No auth in this phase.

**👤 Human**
1. `cd app && npm install && npm test && npm run dev`
2. Browse your own laptop's files at `http://localhost:3000`.
3. Try to break it: `/api/tree?path=../../` — confirm it's rejected.

**✅ Done when:** tests pass and traversal attempts return 400/403.

---

## Phase 6 — Google login + allowlist

**Learn:** OAuth 2.0 vs. OpenID Connect, the authorization-code flow, what
`state`/`nonce`/PKCE protect against, ID tokens, authentication ("who are
you") vs. authorization ("are you on the list").

**👤 Human**
1. Console → **Google Auth Platform** → configure consent screen: External,
   Testing mode. Add yourself as a test user.
2. Create an OAuth client: type "Web application", redirect URI
   `http://localhost:3000/auth/callback` (the production URI is added in Phase 8).
3. Put the client ID/secret in `app/.env` (gitignored). Never paste them in chat or commit them.

**🤖 Agent**
> Branch `phase-6-auth`. Add Google OIDC login using `openid-client`
> (authorization code flow with PKCE, state, nonce). Routes: `/auth/login`,
> `/auth/callback`, `/auth/logout`. On callback, require
> `email_verified === true` and the lowercase email to be in `ALLOWED_EMAILS`
> (comma-separated env var); otherwise render a 403 page and create no session.
> Sessions via signed, encrypted cookies (HttpOnly, SameSite=Lax, Secure in
> production, 8h expiry) keyed by `SESSION_SECRET`. An `requireAuth` middleware
> guards everything except `/auth/*` and `/healthz`. Add CSRF protection on
> logout, rate limiting on `/auth/*`, and tests for: allowlisted user, non-listed
> user, unverified email, missing session. Provide `.env.example`.

**👤 Human**
1. Log in with your allowlisted account → works.
2. Log in with a second Google account → 403.

**✅ Done when:** both of those behave correctly and tests pass.

---

## Phase 7 — Containerize + run on the VM

**Learn:** multi-stage Docker builds, Artifact Registry, Secret Manager, how
the VM's service account pulls images and reads secrets without any passwords.

**🤖 Agent**
> Branch `phase-7-container`. Add `app/Dockerfile` (multi-stage, slim or
> distroless final image, non-root user, `HEALTHCHECK`), `.dockerignore`. In
> `infra/` add `registry.tf` (Artifact Registry docker repo with a cleanup
> policy keeping the last 5 images) and `secrets.tf` (Secret Manager secrets
> for oauth-client-id, oauth-client-secret, session-secret, allowed-emails —
> **create the secret containers only, not the values**; grant the VM service
> account `secretAccessor` on just those four). Add a COS startup script
> (cloud-init) that fetches the secrets, pulls the image, and runs the app
> container with: host `/` mounted read-only at `/host`, `FILE_ROOT=/host`,
> `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
> restart policy `always`. Expose app on port 80 temporarily for this phase.

**👤 Human**
1. Add secret values (they never touch git or Terraform state):
   ```sh
   printf '%s' 'you@gmail.com' | gcloud secrets versions add allowed-emails --data-file=-
   openssl rand -base64 48 | gcloud secrets versions add session-secret --data-file=-
   # ...same for oauth-client-id and oauth-client-secret
   ```
2. Build and push the first image by hand (CI takes over in Phase 10):
   ```sh
   gcloud auth configure-docker us-central1-docker.pkg.dev
   docker build --platform linux/amd64 -t us-central1-docker.pkg.dev/<PROJECT>/app/app:manual app/
   docker push us-central1-docker.pkg.dev/<PROJECT>/app/app:manual
   ```
3. `terraform apply`, then reset the VM so the startup script runs.

**✅ Done when:** `curl http://<EXTERNAL_IP>/healthz` returns ok. (Login won't
work yet — Google requires HTTPS for non-localhost redirects. That's next.)

---

## Phase 8 — Domain + HTTPS

**Learn:** DNS A records, how Let's Encrypt proves you own a domain (ACME
HTTP-01 challenge), reverse proxies, HSTS.

**👤 Human**
1. Get a domain (Cloudflare Registrar or Namecheap, ~$10/yr). *No-cost
   fallback:* `<ip-with-dashes>.sslip.io` works for learning, but a real
   domain is the proper path.
2. Create an A record: `files.<yourdomain>` → the VM's static IP. If using
   Cloudflare, set it to "DNS only" (grey cloud) so Caddy can get its cert.
3. In the OAuth client, add redirect URI `https://files.<yourdomain>/auth/callback`.

**🤖 Agent**
> Branch `phase-8-https`. Add a Caddy container to the startup script:
> listens on 80/443, automatic HTTPS for a `domain` Terraform variable,
> reverse-proxies to the app over a private docker network, persists certs on
> a host volume, sets HSTS and security headers. The app container no longer
> publishes any host port. Set `trust proxy`, `Secure` cookies, and the
> production callback URL via env. Optional: manage the DNS record in
> Terraform if the domain is on Cloudflare/Cloud DNS.

**✅ Done when:** `https://files.<yourdomain>` shows a valid padlock, login
works end to end, and you're browsing the VM's real file tree. 🎉 *This is the
MVP.* Everything after this is about making it maintainable and safe.

---

## Phase 9 — CI (checks on every PR)

**Learn:** GitHub Actions anatomy (workflow → job → step), least-privilege
`permissions:`, why you pin actions to commit SHAs, static analysis for IaC.

**🤖 Agent**
> Branch `phase-9-ci`. Add `.github/workflows/ci.yml` triggered on
> pull_request: **app** job (npm ci, lint, typecheck, test, `npm audit
> --audit-level=high`), **infra** job (`terraform fmt -check`, `init
> -backend=false`, `validate`, tflint, Trivy config scan), **security** job
> (gitleaks, Trivy scan of the built image). Top-level `permissions:
> contents: read`. Pin every third-party action to a full commit SHA. Use path
> filters so app changes don't run infra jobs and vice versa. No GCP access
> in this phase.

**👤 Human**
1. Merge, then update the `main` ruleset: require the CI status checks to pass.
2. Open a throwaway PR with a deliberate lint error and watch it get blocked.

**✅ Done when:** a failing check prevents merging.

---

## Phase 10 — CD (keyless deploys from GitHub)

**Learn:** Workload Identity Federation — GitHub mints a short-lived OIDC
token, GCP trusts it *only* for your repo, and exchanges it for short-lived
credentials. No stored keys anywhere. Also: plan-on-PR / apply-on-merge,
GitHub Environments as an approval gate.

**🤖 Agent**
> Branch `phase-10-cd`. In `infra/wif.tf`: a workload identity pool + GitHub
> OIDC provider with an `attribute_condition` locking it to
> `coltonkirsten/Simple-Agent-Computer`; two service accounts —
> `gha-plan` (read-only/viewer + state bucket read, usable from any PR) and
> `gha-deploy` (the specific roles needed to apply and deploy, usable **only**
> from `refs/heads/main`). Workflows: `terraform-plan.yml` (on PR: plan, post
> the plan as a PR comment), `deploy.yml` (on push to main, in a `production`
> environment: terraform apply, build image tagged with the git SHA, push to
> Artifact Registry, then roll the VM to the new image via IAP SSH or a
> metadata update + container restart, and finish with a smoke test against
> `/healthz`). Workflows need `permissions: id-token: write`.

**👤 Human**
1. This phase's first `terraform apply` is local (CI can't grant itself access).
2. GitHub → Settings → Environments → create `production`, add yourself as a
   required reviewer.
3. Add repo **variables** (not secrets — none of these are sensitive):
   `GCP_PROJECT_ID`, `WIF_PROVIDER`, `PLAN_SA`, `DEPLOY_SA`.
4. Make a small visible change (e.g. page title), PR it, merge, approve the
   deploy, watch it go live.

**✅ Done when:** a merged PR reaches production with no manual commands, and
there are zero service account keys in the project
(`gcloud iam service-accounts keys list` shows only system-managed keys).

---

## Phase 11 — Hardening + operations

**Learn:** observability basics, audit logging, and how to cleanly tear
everything down.

**🤖 Agent**
> Branch `phase-11-ops`. Add: structured JSON logging with an audit line for
> every login (allowed/denied) and file view; container logs shipped to Cloud
> Logging; `monitoring.tf` with an HTTPS uptime check and an email alert
> policy; a strict Content-Security-Policy; `docs/runbook.md` (change the
> allowlist, rotate the session secret, rotate the OAuth secret, roll back a
> deploy, full teardown order); `SECURITY.md`. Review all IAM bindings and
> remove anything unused.

**👤 Human**
1. Add a friend's email to the allowlist via the runbook; confirm they can log in.
2. Stop the container on purpose; confirm you get an alert email.
3. Read through Cloud Logging and find your own login event.

**✅ Done when:** you can answer "who logged in yesterday?" from logs, and
you've done one secret rotation by following the runbook.

---

## After the North Star

Ideas once the foundation is solid — each is its own future phase:

- An in-browser terminal (this is where "agent computer" starts getting real — and where the security model needs a serious rethink)
- File upload/edit with an audit trail
- Staging environment via Terraform workspaces or a second project
- Swap app-level auth for IAP and compare the two approaches

## Glossary

- **ADC** — Application Default Credentials; how local tools find your GCP login.
- **COS** — Container-Optimized OS; Google's minimal, auto-updating OS for running containers.
- **IAP** — Identity-Aware Proxy; here used only for tunneling SSH without an open port.
- **OIDC** — OpenID Connect; identity layer on top of OAuth 2.0. "Sign in with Google" is OIDC.
- **WIF** — Workload Identity Federation; lets GitHub Actions authenticate to GCP without keys.
- **tfstate** — Terraform's record of what it has created. Treat as sensitive.

# Workload Identity Federation (WIF): how GitHub Actions authenticates to GCP
# with NO stored credentials.
#
# The old way: create a service account key (a JSON file), paste it into GitHub
# secrets. That key never expires, works from anywhere on earth, and leaks are
# the #1 cause of cloud breaches. We never create one.
#
# The WIF way:
#   1. At the start of a job, GitHub mints a short-lived OIDC token — a JWT
#      signed by GitHub stating facts ("claims") about the run: which repo,
#      which branch, which workflow, which environment.
#   2. The workflow presents that token to GCP's Security Token Service.
#   3. GCP verifies GitHub's signature, checks the claims against the rules in
#      THIS FILE, and if they pass, swaps it for a GCP token valid ~1 hour
#      that impersonates one of the service accounts below.
#
# Nothing here is secret. Pool names, provider names and service account
# emails can sit in a public repo: they're useless without a token that
# GitHub will only mint for workflows running in this repository.

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Identities federated from GitHub Actions OIDC tokens"

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # Copy claims from GitHub's token into attributes IAM bindings can match on.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository" # "owner/name"
    "attribute.ref"        = "assertion.ref"        # "refs/heads/main", "refs/pull/12/merge", ...
  }

  # THE most important line in this file. GitHub's OIDC issuer is shared by
  # every repository on GitHub: without this condition, a workflow in ANYONE's
  # repo could present a validly signed token to this provider.
  #
  # It matches the numeric repository ID rather than the "owner/name" string:
  # names can be renamed, transferred, or re-registered by someone else after
  # an account deletion. The ID is permanent and never reused.
  attribute_condition = "assertion.repository_id == \"${var.github_repository_id}\""
}

locals {
  # "Any identity from the pool whose <attribute> equals <value>."
  wif_principal_prefix = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"
  wif_any_branch       = "${local.wif_principal_prefix}/attribute.repository/${var.github_repository}"
  wif_main_only        = "${local.wif_principal_prefix}/attribute.ref/refs/heads/main"
}

# ------------------------------------------------------------------------------
# gha-plan: READ-ONLY. Used by `terraform plan` on pull requests.
#
# Usable from any branch of this repo — which is safe because it can't change
# anything. (PRs from FORKS can't use it at all: GitHub refuses to mint OIDC
# tokens for fork PRs.)
# ------------------------------------------------------------------------------
resource "google_service_account" "gha_plan" {
  account_id   = "gha-plan"
  display_name = "GitHub Actions: terraform plan (read-only)"

  depends_on = [google_project_service.enabled]
}

resource "google_service_account_iam_member" "gha_plan_wif" {
  service_account_id = google_service_account.gha_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.wif_any_branch
}

locals {
  gha_plan_roles = [
    "roles/viewer",                         # read resource configuration
    "roles/iam.securityReviewer",           # read IAM policies (viewer can't)
    "roles/iam.workloadIdentityPoolViewer", # read the pool/provider above
  ]
}

resource "google_project_iam_member" "gha_plan" {
  for_each = toset(local.gha_plan_roles)

  project = var.project_id
  role    = each.value
  member  = google_service_account.gha_plan.member
}

# Read the state file. Note: roles/viewer deliberately can NOT read secret
# values (secretmanager.versions.access) — and we never put any in state.
resource "google_storage_bucket_iam_member" "gha_plan_state" {
  bucket = local.state_bucket
  role   = "roles/storage.objectViewer"
  member = google_service_account.gha_plan.member
}

# ------------------------------------------------------------------------------
# gha-deploy: READ-WRITE. Used by the deploy workflow.
#
# Usable ONLY when the token's ref is refs/heads/main. A workflow on a feature
# branch or a PR cannot impersonate it, no matter what its YAML says — and
# code only reaches main through a reviewed PR with passing CI.
#
# Honest caveat: an identity that runs `terraform apply` on a config that
# manages IAM is, in effect, a project admin — it could grant itself anything.
# The role list below documents what it needs rather than truly confining it.
# The real protections are (1) the main-only binding here, (2) branch
# protection on main, and (3) the manual approval on the GitHub "production"
# environment.
# ------------------------------------------------------------------------------
resource "google_service_account" "gha_deploy" {
  account_id   = "gha-deploy"
  display_name = "GitHub Actions: terraform apply + deploy (main only)"

  depends_on = [google_project_service.enabled]
}

resource "google_service_account_iam_member" "gha_deploy_wif" {
  service_account_id = google_service_account.gha_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.wif_main_only
}

locals {
  gha_deploy_roles = [
    "roles/compute.admin",                   # VM, network, firewall, address; stop/start
    "roles/artifactregistry.admin",          # push images; manage the repo + cleanup policy
    "roles/secretmanager.admin",             # manage secret containers + their IAM
    "roles/iam.serviceAccountAdmin",         # manage service accounts
    "roles/iam.workloadIdentityPoolAdmin",   # manage the pool/provider above
    "roles/resourcemanager.projectIamAdmin", # manage project-level role bindings
    "roles/serviceusage.serviceUsageAdmin",  # enable APIs
    "roles/iap.admin",                       # manage IAP tunnel access
    "roles/monitoring.admin",                # uptime check, alert policy, notification channel
  ]
}

resource "google_project_iam_member" "gha_deploy" {
  for_each = toset(local.gha_deploy_roles)

  project = var.project_id
  role    = each.value
  member  = google_service_account.gha_deploy.member
}

# Changing a VM that runs as a service account requires permission to "act as"
# that account — otherwise compute.admin could be used to borrow any SA's power.
resource "google_service_account_iam_member" "gha_deploy_uses_vm_sa" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.gha_deploy.member
}

# Read, write and lock the state file — and manage this bucket's IAM, since
# the two bucket bindings in this file are themselves Terraform resources.
# Scoped to the ONE bucket, not project-wide storage.
resource "google_storage_bucket_iam_member" "gha_deploy_state" {
  bucket = local.state_bucket
  role   = "roles/storage.admin"
  member = google_service_account.gha_deploy.member
}

locals {
  # Created by hand in docs/bootstrap.md, so referenced by name, not managed here.
  state_bucket = "${var.project_id}-tfstate"
}

# Secret Manager holds the four values the app needs at runtime.
#
# IMPORTANT: Terraform creates only the empty CONTAINERS. The secret VALUES
# are added by hand with `gcloud secrets versions add`. Anything Terraform
# manages is written to its state file in plain text — so a secret value set
# through Terraform would be sitting readable in the state bucket.
locals {
  app_secrets = [
    "oauth-client-id",
    "oauth-client-secret",
    "session-secret",
    "allowed-emails", # not a credential, but keeps emails out of the public repo
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each = toset(local.app_secrets)

  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

# Least privilege: the VM may read THESE four secrets and nothing else. A
# project-level secretAccessor grant would also work — and would silently
# cover every secret anyone adds to this project in future.
resource "google_secret_manager_secret_iam_member" "vm_reads" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.vm.member
}

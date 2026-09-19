# In GCP every service's API is off by default, per project. Nothing else in
# this config can be created until the matching API is enabled.
locals {
  apis = [
    "cloudresourcemanager.googleapis.com", # project-level IAM bindings
    "compute.googleapis.com",              # VM, VPC, firewall (Phase 4)
    "iam.googleapis.com",                  # service accounts (Phase 4)
    "iamcredentials.googleapis.com",       # short-lived tokens for WIF (Phase 10)
    "iap.googleapis.com",                  # SSH tunnel without an open port 22 (Phase 4)
    "secretmanager.googleapis.com",        # OAuth secret, session key, allowlist (Phase 7)
    "artifactregistry.googleapis.com",     # docker images (Phase 7)
    "logging.googleapis.com",              # container logs (Phase 11)
    "monitoring.googleapis.com",           # uptime check + alerts (Phase 11)
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.apis)

  service = each.value

  # If this resource is ever removed from the config, leave the API enabled
  # rather than switching it off underneath things that depend on it.
  disable_on_destroy = false
}

# Artifact Registry: a private Docker registry inside the project. CI pushes
# images here (Phase 10); the VM pulls from here using its service account
# (roles/artifactregistry.reader in iam.tf) — no registry passwords anywhere.
resource "google_artifact_registry_repository" "app" {
  repository_id = "app"
  location      = var.region
  format        = "DOCKER"
  description   = "Simple Agent Computer app images"

  # Every deploy pushes a new image, and storage beyond 0.5 GB is billed.
  # Cleanup policies are evaluated together: DELETE anything older than a day,
  # EXCEPT whatever a KEEP policy protects (the 5 newest versions).
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "86400s"
    }
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  depends_on = [google_project_service.enabled]
}

locals {
  registry_host = "${var.region}-docker.pkg.dev"
  image_repo    = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/app"
}

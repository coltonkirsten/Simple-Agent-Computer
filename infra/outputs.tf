# Values printed after `terraform apply` (and readable with `terraform output`).

output "project_id" {
  description = "The project this configuration manages."
  value       = var.project_id
}

output "region" {
  value = var.region
}

output "enabled_apis" {
  description = "APIs enabled by this configuration."
  value       = sort([for s in google_project_service.enabled : s.service])
}

output "vm_name" {
  value = google_compute_instance.vm.name
}

output "external_ip" {
  description = "Static public IP of the VM. Point DNS here in Phase 8."
  value       = google_compute_address.vm.address
}

output "ssh_command" {
  description = "Paste to SSH in through the IAP tunnel."
  value       = "gcloud compute ssh ${google_compute_instance.vm.name} --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "image" {
  description = "Full image reference to build, push and run."
  value       = "${local.image_repo}:${var.app_image_tag}"
}

output "registry_host" {
  description = "For: gcloud auth configure-docker <this>"
  value       = local.registry_host
}

output "url" {
  description = "Where the app lives."
  value       = "https://${var.domain}"
}

output "oauth_redirect_uri" {
  description = "Must be listed under \"Authorized redirect URIs\" on the Google OAuth client."
  value       = "https://${var.domain}/auth/callback"
}

output "zone" {
  value = var.zone
}

output "app_image_tag" {
  description = "Tag currently deployed. CI passes it back into `plan` so an unrelated PR doesn't show an image diff."
  value       = var.app_image_tag
}

output "image_repo" {
  description = "Image path without a tag."
  value       = local.image_repo
}

# --- Values for GitHub repo variables (none are secret; see wif.tf) ---

output "wif_provider" {
  description = "GitHub variable WIF_PROVIDER"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "plan_sa" {
  description = "GitHub variable PLAN_SA"
  value       = google_service_account.gha_plan.email
}

output "deploy_sa" {
  description = "GitHub variable DEPLOY_SA"
  value       = google_service_account.gha_deploy.email
}

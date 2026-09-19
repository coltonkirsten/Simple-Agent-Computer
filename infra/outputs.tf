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

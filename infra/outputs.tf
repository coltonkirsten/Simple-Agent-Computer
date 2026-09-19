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

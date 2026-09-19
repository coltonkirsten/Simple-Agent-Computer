# Inputs to this configuration. Values come from terraform.tfvars (gitignored).

variable "project_id" {
  description = "GCP project ID (not the display name or project number)."
  type        = string
}

variable "region" {
  description = "GCP region. The e2-micro free tier only applies in us-central1, us-west1 and us-east1."
  type        = string
  default     = "us-central1"

  validation {
    condition     = contains(["us-central1", "us-west1", "us-east1"], var.region)
    error_message = "Pick a free-tier region: us-central1, us-west1 or us-east1."
  }
}

variable "zone" {
  description = "GCP zone within the region, e.g. us-central1-a."
  type        = string
  default     = "us-central1-a"
}

variable "vm_name" {
  description = "Name of the Compute Engine instance."
  type        = string
  default     = "sac-vm"
}

variable "admin_email" {
  description = "Google account allowed to SSH into the VM through IAP. Kept in tfvars so it stays out of the public repo."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.admin_email))
    error_message = "admin_email must be a plain email address (no \"user:\" prefix)."
  }
}

variable "app_image_tag" {
  description = "Tag of the app image the VM runs. \"manual\" until CI takes over in Phase 10."
  type        = string
  default     = "manual"
}

variable "domain" {
  description = "Hostname the app is served on, e.g. files.example.com. Its DNS A record must point at the VM's external_ip BEFORE the VM boots with this config, or Let's Encrypt can't validate it."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a bare lowercase hostname like files.example.com (no https://, no path)."
  }
}

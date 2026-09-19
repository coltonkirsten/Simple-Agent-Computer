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

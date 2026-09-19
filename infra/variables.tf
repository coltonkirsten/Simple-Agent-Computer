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

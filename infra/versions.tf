# Pin the tools so `terraform plan` behaves the same on your laptop, in CI,
# and six months from now.
#
# "~> 1.16" means ">= 1.16, < 2.0"  — any 1.x release from 1.16 onward.
# "~> 8.3"  means ">= 8.3,  < 9.0"  — minor/patch updates OK, no major bumps.
#
# The exact provider version + checksums actually used are recorded in
# .terraform.lock.hcl, which IS committed.
terraform {
  required_version = "~> 1.16"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.3"
    }
  }
}

# The provider is the plugin that turns Terraform resources into GCP API calls.
# It authenticates using Application Default Credentials
# (`gcloud auth application-default login`) — no keys in this repo.
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

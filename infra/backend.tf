# Where Terraform stores its state (its record of what it has created).
#
# Remote state in GCS instead of a local file means:
#   - it isn't lost if your laptop dies
#   - CI can use the same state later (Phase 10)
#   - GCS provides locking, so two applies can't run at once and corrupt it
#   - bucket versioning lets you roll back a bad state file
#
# Backend blocks can't use variables, so the bucket name is supplied at init:
#   terraform init -backend-config="bucket=<PROJECT_ID>-tfstate"
terraform {
  backend "gcs" {
    prefix = "terraform/state"
  }
}

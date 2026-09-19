# tflint catches what `terraform validate` can't: deprecated syntax, unused
# declarations, missing version pins — and, with the Google ruleset, invalid
# GCP values (e.g. a machine type that doesn't exist) before any API call.
config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "google" {
  enabled = true
  version = "0.39.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

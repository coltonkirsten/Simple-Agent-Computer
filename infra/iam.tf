# --- The VM's identity --------------------------------------------------------
# Every VM runs as a service account. By default that's the "Compute Engine
# default service account", which has the broad Editor role on the whole
# project — if the VM were compromised, so would everything else be.
# Instead the VM gets its own account with only the roles it needs.
resource "google_service_account" "vm" {
  account_id   = "sac-vm"
  display_name = "Simple Agent Computer VM"

  depends_on = [google_project_service.enabled]
}

locals {
  vm_roles = [
    "roles/logging.logWriter",       # ship logs to Cloud Logging
    "roles/monitoring.metricWriter", # ship metrics to Cloud Monitoring
    "roles/artifactregistry.reader", # pull the app image (Phase 7)
  ]
}

# google_project_iam_member ADDS one binding and leaves the rest of the
# project's IAM policy alone. (Its cousins _binding and _policy are
# authoritative and can lock you out of your own project — avoid them.)
resource "google_project_iam_member" "vm" {
  for_each = toset(local.vm_roles)

  project = var.project_id
  role    = each.value
  member  = google_service_account.vm.member
}

# --- Admin SSH access ----------------------------------------------------------
# Three things are needed to SSH in via IAP + OS Login. As project Owner you
# already have them implicitly; they're spelled out here, scoped to just this
# VM, so access is explicit and would work for a non-owner admin too.

# 1. Permission to open an IAP tunnel to this instance.
resource "google_iap_tunnel_instance_iam_member" "admin" {
  instance = google_compute_instance.vm.name
  zone     = var.zone
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${var.admin_email}"
}

# 2. Permission to log in, with sudo, via OS Login. OS Login ties SSH access
#    to your Google identity + IAM instead of long-lived keys in VM metadata.
resource "google_compute_instance_iam_member" "admin_os_login" {
  instance_name = google_compute_instance.vm.name
  zone          = var.zone
  role          = "roles/compute.osAdminLogin"
  member        = "user:${var.admin_email}"
}

# 3. Logging in to a VM lets you act as its service account, so GCP requires
#    explicit permission to "use" that account.
resource "google_service_account_iam_member" "admin_uses_vm_sa" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "user:${var.admin_email}"
}

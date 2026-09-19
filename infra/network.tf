# A dedicated VPC instead of the project's "default" network. The default
# network ships with permissive firewall rules (SSH/RDP/ICMP open to the
# world); starting from an empty custom network means nothing is reachable
# unless a rule below says so.
resource "google_compute_network" "main" {
  name = "sac-vpc"

  # "Custom mode": we define subnets ourselves rather than getting one
  # auto-created in every region.
  auto_create_subnetworks = false

  depends_on = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "main" {
  name          = "sac-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"

  # Lets the VM reach Google APIs (Artifact Registry, Secret Manager) over
  # Google's internal network.
  private_ip_google_access = true
}

# --- Firewall ---------------------------------------------------------------
# GCP firewalls are default-deny for ingress. Rules attach to VMs through
# network tags: a rule with target_tags = ["web"] only applies to VMs
# carrying the "web" tag.

resource "google_compute_firewall" "allow_web" {
  name        = "sac-allow-web"
  network     = google_compute_network.main.id
  description = "HTTP/HTTPS from anywhere to VMs tagged 'web'."

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["web"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "allow_iap_ssh" {
  name        = "sac-allow-iap-ssh"
  network     = google_compute_network.main.id
  description = "SSH only from Google's IAP TCP-forwarding range."

  direction = "INGRESS"
  # This is the fixed range IAP tunnels come from. Port 22 is NOT open to the
  # internet: to reach it you must first authenticate to Google and hold the
  # IAP tunnel role (see iam.tf). No bastion host, no VPN, no exposed sshd.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["iap-ssh"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

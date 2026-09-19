# A reserved external IP. Without this the VM gets an ephemeral IP that can
# change on restart, which would break the DNS record in Phase 8.
# (A static IP is free while attached to a running VM; an unattached one is billed.)
resource "google_compute_address" "vm" {
  name   = "sac-vm-ip"
  region = var.region

  depends_on = [google_project_service.enabled]
}

resource "google_compute_instance" "vm" {
  name         = var.vm_name
  machine_type = "e2-micro" # 2 shared vCPU, 1 GB RAM — the free-tier machine
  zone         = var.zone

  # Which firewall rules apply to this VM (see network.tf).
  tags = ["web", "iap-ssh"]

  boot_disk {
    initialize_params {
      # Container-Optimized OS: Google's minimal, hardened, auto-updating
      # image whose only job is running containers. Mostly read-only root
      # filesystem, no package manager — far less to attack or to maintain.
      image = "cos-cloud/cos-stable"
      size  = 30            # GB — the free-tier allowance
      type  = "pd-standard" # free tier covers standard disks, not SSD
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id

    # access_config = "give this interface an external IP".
    #
    # Accepted risk: security scanners flag public IPs on VMs (the recommended
    # pattern is a load balancer in front of private instances). This VM IS
    # the web server — a load balancer costs ~$18/mo, see NORTH_STAR.md "Key
    # decisions". Exposure is limited by the firewall (80/443 only, SSH via
    # IAP) and Caddy being the only listener.
    #trivy:ignore:GCP-0031
    access_config {
      nat_ip = google_compute_address.vm.address
    }
  }

  service_account {
    email = google_service_account.vm.email
    # Scopes are a legacy second permission layer. Best practice: set the
    # broad cloud-platform scope and control real access purely with the IAM
    # roles in iam.tf.
    scopes = ["cloud-platform"]
  }

  # Shielded VM: verifies the boot chain hasn't been tampered with
  # (bootkits/rootkits).
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE" # SSH access decided by IAM, not by keys in metadata
    block-project-ssh-keys = "TRUE" # ignore any project-wide SSH keys

    # Turns on COS's built-in logging agent, which ships container output
    # (the app's JSON audit lines, Caddy's access log) and system logs to
    # Cloud Logging. Without it, logs live only on the VM's disk — and die
    # with it, which is exactly when you'd want them. Authenticates as the
    # VM's service account (roles/logging.logWriter in iam.tf).
    google-logging-enabled = "true"

    # cloud-init config, applied on every boot. Changing it updates the VM's
    # metadata in place but does NOT re-run it: reset the VM to apply.
    user-data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      project_id    = var.project_id
      registry_host = local.registry_host
      image         = "${local.image_repo}:${var.app_image_tag}"
      base_url      = "https://${var.domain}"
      start_script  = file("${path.module}/start-app.sh")
      caddy_script  = file("${path.module}/start-caddy.sh")
      caddyfile     = templatefile("${path.module}/Caddyfile.tftpl", { domain = var.domain })
    })
  }

  # Some changes (e.g. service account, machine type) require a stop/start.
  # Allow Terraform to do that rather than failing.
  allow_stopping_for_update = true
}

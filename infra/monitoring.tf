# Monitoring: find out the site is down from an email, not from a user.

# An uptime check is Google probing the public URL from several regions around
# the world — testing what users actually experience (DNS, TLS certificate,
# Caddy, the app), not just "is the VM powered on".
resource "google_monitoring_uptime_check_config" "healthz" {
  display_name = "sac-healthz"
  timeout      = "10s"
  period       = "300s" # every 5 minutes, per region

  http_check {
    path         = "/healthz"
    port         = 443
    use_ssl      = true
    validate_ssl = true # an expired or broken certificate counts as DOWN
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.domain
    }
  }

  # A 200 isn't enough: the body must be the app's own health response.
  content_matchers {
    content = "\"status\":\"ok\""
    matcher = "CONTAINS_STRING"
  }

  # The gha_deploy dependency is about ORDER on the very first apply: CI's own
  # identity gains roles/monitoring.admin in the same run that creates these
  # resources, so the grant must happen first. (IAM changes can take a minute
  # to propagate; if that first deploy fails with a 403 here, just re-run it.)
  depends_on = [google_project_service.enabled, google_project_iam_member.gha_deploy]
}

resource "google_monitoring_notification_channel" "email" {
  display_name = "Admin email"
  type         = "email"

  labels = {
    email_address = var.admin_email
  }

  depends_on = [google_project_service.enabled, google_project_iam_member.gha_deploy]
}

resource "google_monitoring_alert_policy" "site_down" {
  display_name = "Site down: ${var.domain}"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing from more than one region"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz.uptime_check_id}\"",
        "resource.type=\"uptime_url\"",
      ])

      # Count the regions reporting failure; alert when more than one does.
      # (One region failing alone is usually that region's network, not us.)
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 1

      # Must stay down for 10 minutes before anyone is emailed. A deploy
      # restarts the VM (~2 min of expected downtime); without this, every
      # merge would page you. Alerts that cry wolf get ignored.
      duration = "600s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    mime_type = "text/markdown"
    content   = "https://${var.domain}/healthz is failing from multiple regions. See docs/runbook.md → \"The site is down\" in the repo."
  }
}

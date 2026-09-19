# Runbook

How to operate the thing. Commands assume `gcloud` is pointed at the project
(`gcloud config get project`) and, for `terraform output`, that you're in `infra/`.

Shorthand used below:

```sh
VM_SSH="gcloud compute ssh sac-vm --zone us-central1-a --tunnel-through-iap"
```

---

## Who did what? (reading the audit log)

The app writes one JSON line per security-relevant event; the VM ships them to
Cloud Logging. Events: `login_allowed`, `login_denied`, `login_failed`,
`logout`, `dir_list`, `file_view`, `access_denied`.

Console: **Logging → Logs Explorer**, paste a query, pick a time range.

```
"login_allowed"
```
```
"login_denied" OR "access_denied"
```
```
"file_view" AND "someone@gmail.com"
```

Same from the terminal — e.g. who logged in during the last day:

```sh
gcloud logging read '"login_allowed"' --freshness=1d --format='value(timestamp, jsonPayload.message, textPayload)'
```

Straight from the VM (works even if log shipping is broken):

```sh
$VM_SSH --command 'sudo journalctl -u sac-app --since "1 hour ago" --no-pager | grep login_'
```

## Change who can log in

The allowlist is the `allowed-emails` secret: comma-separated, case-insensitive.
Adding a version replaces the whole list, so include everyone who should keep access.

```sh
printf '%s' 'you@gmail.com,friend@gmail.com' | gcloud secrets versions add allowed-emails --data-file=-
$VM_SSH --command 'sudo systemctl restart sac-app'
```

The restart re-fetches secrets (~10 s of downtime). Removal takes effect on the
removed person's **next request** after the restart — the allowlist is checked
on every request, not just at login.

While the OAuth consent screen is in *Testing* mode, a new person must also be
added as a **test user**: Console → Google Auth Platform → Audience.

## Rotate the session secret

Do this if you suspect it leaked, or periodically. Effect: **everyone is logged
out** (their cookies can no longer be decrypted) and simply logs in again.

```sh
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add session-secret --data-file=-
$VM_SSH --command 'sudo systemctl restart sac-app'
```

Then retire the old version so it can never be used again:

```sh
gcloud secrets versions list session-secret
gcloud secrets versions disable OLD_VERSION_NUMBER --secret=session-secret
```

## Rotate the OAuth client secret

1. Console → Google Auth Platform → Clients → your client → **Add secret**.
   (Google allows two active secrets precisely so rotation has no downtime.)
2. Store the new one and restart:
   ```sh
   printf '%s' 'NEW_SECRET' | gcloud secrets versions add oauth-client-secret --data-file=-
   $VM_SSH --command 'sudo systemctl restart sac-app'
   ```
3. Log in once to prove it works.
4. Back in the console, **disable then delete the old secret**. Disable the old
   Secret Manager version too (as above).
5. Update `app/.env` on your laptop if you still develop locally.

## Deploy

Merge a PR to `main`, approve the `production` deployment in the Actions tab.
~4 minutes, including ~2 minutes of downtime while the VM restarts.

## Roll back a bad deploy

Fastest — redeploy a known-good image without rebuilding:

1. Find the last good commit SHA: `git log --oneline main` (full SHA: `git rev-parse <short>`),
   or look at a previous successful Deploy run.
2. Actions → **Deploy** → **Run workflow** → `image_tag` = that full SHA → approve.

This rolls back the **app image only**. Infra is whatever `main` says. To undo
an infra change, revert the commit with a PR (`git revert <sha>`) and merge it.

The images kept for rollback are the 5 most recent (cleanup policy in `infra/registry.tf`).

## The site is down

Work from the outside in; stop at the first thing that's wrong.

```sh
dig +short files.sourcecast.app                       # 1. DNS → should be the VM's IP
curl -sv https://files.sourcecast.app/healthz         # 2. TLS + app → cert error? 502? timeout?
gcloud compute instances describe sac-vm --zone us-central1-a --format='value(status)'   # 3. RUNNING?
$VM_SSH --command 'sudo systemctl status sac-app sac-caddy --no-pager; docker ps'         # 4. services
$VM_SSH --command 'sudo journalctl -u sac-app -n 50 --no-pager'                           # 5. why
```

| Symptom | Usual cause |
|---|---|
| Timeout on 443, 80 works | Caddy isn't running → `journalctl -u sac-caddy` |
| `502` from Caddy | App container down or still starting → `journalctl -u sac-app` |
| App restart loop mentioning a secret | A secret has no enabled version |
| Certificate error | DNS changed, or Let's Encrypt rate limit → Caddy log |
| Everything looks fine on the VM | Firewall or DNS — go back to steps 1–2 |

Blunt but effective: `gcloud compute instances reset sac-vm --zone us-central1-a`
re-runs the whole boot sequence.

## Alerts

`infra/monitoring.tf` probes `/healthz` from several regions every 5 minutes
and emails the admin after **10 minutes** of failure from more than one region
(long enough that deploys don't page you). The first time, Google sends a
verification email to the address — click it, or alerts won't arrive.

See incidents: Console → Monitoring → Alerting.

## Tear everything down

In this order, so nothing is orphaned or left billing:

1. **Infra** — locally, from `infra/`: `terraform destroy`
   (the static IP starts costing money the moment it's detached from a VM, so
   don't leave a half-destroyed project around).
2. **The project** — deletes the state bucket, secrets, logs, everything else:
   `gcloud projects delete <PROJECT_ID>` (recoverable for 30 days).
3. **DNS** — delete the `files` A record at GoDaddy. A record pointing at an IP
   you no longer own is a "dangling DNS" takeover risk: whoever is assigned
   that IP next can serve content on your domain.
4. **Google OAuth client** — deleted with the project.
5. **GitHub** — delete the `production` environment and the repo variables /
   `ADMIN_EMAIL` secret (Settings → Environments, → Secrets and variables).
6. **Billing** — check the budget page a few days later to confirm $0.

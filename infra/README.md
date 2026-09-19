# infra/

Terraform for everything in GCP. Flat on purpose — no modules — so you can
read it top to bottom.

## Files

| File | Purpose |
|---|---|
| `versions.tf` | Pins Terraform + the Google provider; configures the provider |
| `backend.tf` | Stores state in the GCS bucket created in [bootstrap](../docs/bootstrap.md) |
| `variables.tf` | Inputs (`project_id`, `region`, `zone`, `vm_name`, `admin_email`, `domain`, `app_image_tag`) |
| `terraform.tfvars.example` | Template for your gitignored `terraform.tfvars` |
| `apis.tf` | Enables the GCP APIs later phases need |
| `network.tf` | Custom VPC, subnet, firewall rules (80/443 public, 22 from IAP only) |
| `iam.tf` | The VM's least-privilege service account; admin SSH access via IAP + OS Login |
| `vm.tf` | Static IP + the e2-micro Container-Optimized OS instance |
| `registry.tf` | Artifact Registry docker repo + cleanup policy |
| `secrets.tf` | Secret Manager containers (no values!) + per-secret read access for the VM |
| `cloud-init.yaml.tftpl` | Boot-time config for the VM: writes the scripts, Caddyfile and systemd units below |
| `start-app.sh` | Runs on the VM: fetch secrets → pull image → run the hardened app container (no published port) |
| `start-caddy.sh` | Runs on the VM: the Caddy container — the only thing listening on 80/443 |
| `Caddyfile.tftpl` | Caddy config: automatic HTTPS for `var.domain`, reverse proxy to the app, HSTS |
| `monitoring.tf` | Uptime check on `/healthz` from multiple regions + email alert after 10 min down |
| `wif.tf` | Workload Identity Federation: keyless GitHub Actions → GCP auth, plus the `gha-plan` (read-only) and `gha-deploy` (main only) service accounts |
| `outputs.tf` | Values printed after apply |
| `.terraform.lock.hcl` | Exact provider version + checksums. **Committed.** |

## First-time setup

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # then edit project_id
terraform init -backend-config="bucket=<PROJECT_ID>-tfstate"
```

`init` downloads the provider and connects to the state bucket. Re-run it
whenever providers or the backend change.

## The loop

```sh
terraform fmt        # format files
terraform validate   # catch syntax/type errors, no GCP calls
terraform plan       # show what WOULD change — always read this
terraform apply      # make the changes (asks for confirmation)
```

Reading a plan: `+` create, `~` update in place, `-` destroy, `-/+` destroy
and recreate (watch out for these on anything stateful).

A healthy config is **idempotent**: right after an apply, `terraform plan`
must say `No changes.`

## SSH

Port 22 is closed to the internet. Connect through the IAP tunnel:

```sh
$(terraform output -raw ssh_command)
```

## How changes reach production

**Merging to `main` is the deploy.** `.github/workflows/deploy.yml` builds the
image (tagged with the commit SHA), runs `terraform apply`, restarts the VM and
checks `/healthz` reports the new SHA. PRs touching `infra/` get a plan
comment from `terraform-plan.yml`.

Consequences for working locally:

- Don't `terraform apply` from your laptop any more — state now records the
  SHA that CI deployed, and a local apply would reset the image tag to its
  default. To **plan** locally without that noise:
  `terraform plan -var app_image_tag=$(terraform output -raw app_image_tag)`
- Roll back: Actions → Deploy → Run workflow → enter an older commit SHA as `image_tag`.
- Exception: changes to `wif.tf` that CI can't apply to itself (e.g. it lost
  a permission it needs) must be applied locally.

## Deploying the app by hand (break-glass only)

```sh
gcloud auth configure-docker $(terraform output -raw registry_host)
docker build --platform linux/amd64 -t $(terraform output -raw image) ../app
docker push $(terraform output -raw image)
gcloud compute ssh sac-vm --zone us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl restart sac-app'
```

`--platform linux/amd64` matters on Apple Silicon: the VM is x86.

Debugging on the VM:

```sh
sudo systemctl status sac-app sac-caddy   # are they running?
sudo journalctl -u sac-app -n 50          # app: script + container output
sudo journalctl -u sac-caddy -n 50        # caddy: certificate issuance shows up here
docker ps                                 # both containers up; sac-app says (healthy)
```

Changing `cloud-init.yaml.tftpl` or `start-app.sh` only updates metadata;
cloud-init re-reads it at boot: `gcloud compute instances reset sac-vm --zone us-central1-a`

## Rules

- Never commit `terraform.tfvars` or any `*.tfstate` file.
- Never put secret *values* in Terraform — they end up in state in plain text.
- Don't change things by hand in the console once Terraform manages them;
  the next apply will fight you ("drift").

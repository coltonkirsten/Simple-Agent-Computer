# infra/

Terraform for everything in GCP. Flat on purpose — no modules — so you can
read it top to bottom.

## Files

| File | Purpose |
|---|---|
| `versions.tf` | Pins Terraform + the Google provider; configures the provider |
| `backend.tf` | Stores state in the GCS bucket created in [bootstrap](../docs/bootstrap.md) |
| `variables.tf` | Inputs (`project_id`, `region`, `zone`, `vm_name`, `admin_email`) |
| `terraform.tfvars.example` | Template for your gitignored `terraform.tfvars` |
| `apis.tf` | Enables the GCP APIs later phases need |
| `network.tf` | Custom VPC, subnet, firewall rules (80/443 public, 22 from IAP only) |
| `iam.tf` | The VM's least-privilege service account; admin SSH access via IAP + OS Login |
| `vm.tf` | Static IP + the e2-micro Container-Optimized OS instance |
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

## Rules

- Never commit `terraform.tfvars` or any `*.tfstate` file.
- Never put secret *values* in Terraform — they end up in state in plain text.
- Don't change things by hand in the console once Terraform manages them;
  the next apply will fight you ("drift").

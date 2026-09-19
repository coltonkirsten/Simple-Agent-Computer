# Bootstrap (one-time, manual)

The steps that had to happen by hand before Terraform could manage anything.
Follow this to recreate the project from scratch.

Placeholders: `<PROJECT_ID>` is the globally-unique project ID,
`<REGION>` is a free-tier region (`us-central1`, `us-west1` or `us-east1`).

## 1. Project + billing (console)

1. https://console.cloud.google.com → project picker → **New project**.
2. **Billing** → link the project to a billing account.
3. **Billing → Budgets & alerts** → create a **$5** budget scoped to this
   project, alert thresholds at 50% / 90% / 100%.
   A budget only *alerts* — it does not cap spending.

## 2. Local credentials

```sh
gcloud auth login                         # you, for gcloud commands
gcloud config set project <PROJECT_ID>
gcloud auth application-default login     # ADC — what Terraform uses
gcloud auth application-default set-quota-project <PROJECT_ID>
```

## 3. Terraform state bucket

The one resource Terraform can't create for itself, because it needs
somewhere to store state before it can create anything.

```sh
gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
  --location=<REGION> \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```

- `--uniform-bucket-level-access`: IAM only, no per-object ACLs to misconfigure.
- `--public-access-prevention`: the bucket can never be made public, even by mistake.
- `--versioning`: every state write keeps the previous version, so a corrupted
  state can be rolled back.

## 4. Hand over to Terraform

Continue with [infra/README.md](../infra/README.md).

## Teardown

Deleting the project removes everything in it, including this bucket:

```sh
gcloud projects delete <PROJECT_ID>
```

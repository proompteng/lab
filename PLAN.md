# Plan for #1900 – Deploy Kestra via Argo CD

## Scope
Deploy Kestra into the lab cluster through Argo CD using the official Helm chart (v1.0.18), with persistent Postgres (CloudNativePG) and MinIO-backed storage, exposed on the tailnet as `kestra`.

## Work items
- [x] Add Kestra app manifests under `argocd/applications/kestra/` (Helm values, CNPG cluster, MinIO tenant/secret/bucket job, tailscale service).
- [x] Register Kestra in `argocd/applicationsets/platform.yaml` (manual automation, sync-wave 4).
- [x] Document rollout/secret handling in `argocd/applications/kestra/README.md` and record this plan.
- [ ] Reseal `minio-credentials-sealedsecret.yaml` with the cluster SealedSecrets cert (required before first sync).
- [ ] First Argo CD sync and tailnet smoke test (post-merge/with cluster access).

## Validation commands
- `kustomize build argocd/applications/kestra`
- `helm template kestra kestra/kestra --version 1.0.18 -f argocd/applications/kestra/kestra-values.yaml --namespace kestra`
- `kubectl apply --dry-run=client -k argocd/applications/kestra`

## Notes/Risks
- MinIO credentials are sealed with a placeholder cert; regenerate with the live SealedSecrets public key before syncing.
- Bucket init job depends on the reflected `kestra-minio-creds` Secret; verify reflection before running workflows.
- Tailscale LB assumes the operator is ready in the cluster; keep automation manual for the first rollout.

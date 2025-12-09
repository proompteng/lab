# Plan for #1900 – Deploy Kestra via Argo CD

## Scope
Deploy Kestra (Helm `kestra/kestra` v1.0.18) into the lab cluster using Argo CD with external Postgres (CloudNativePG) and MinIO-backed storage, exposed on the tailnet as `kestra`.

## Work items
1) Add Kestra Argo CD app with Helm values + supporting manifests (CNPG cluster, MinIO tenant, bucket job, tailscale LB).
2) Register the app in `argocd/applicationsets/platform.yaml` (manual sync first).
3) Document ops/secret rotation and run local validations.

## Validation
- `kustomize build argocd/applications/kestra`
- `helm template kestra kestra/kestra --version 1.0.18 -f argocd/applications/kestra/kestra-values.yaml --namespace kestra`
- `kubectl apply --dry-run=client -k argocd/applications/kestra`

## Notes/Risks
- DinD sidecar disabled by default; enable in values if Docker runner tasks are required.
- MinIO keys are sealed (reflected into `kestra`); rotate via kubeseal using the sealed-secrets controller cert.

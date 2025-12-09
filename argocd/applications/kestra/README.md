# Kestra (lab)

- Helm chart: `kestra/kestra` `1.0.18`, deployed via Kustomize helmCharts.
- Namespace: `kestra`; Postgres via CloudNativePG cluster `kestra-db` (50Gi, longhorn, pod monitor enabled).
- Object storage: MinIO tenant `kestra` in namespace `minio` (1 server, 2x20Gi). Root creds live in `kestra-minio-creds` (SealedSecret in `minio`, reflected to `kestra`).
- Tailscale exposure: `Service/kestra-tailscale` (`loadBalancerClass: tailscale`, hostname `kestra`) targets the chart `kestra` service on port 80→8080.
- Bucket init: `Job/kestra-minio-bucket` waits for the tenant and creates the `kestra` bucket.

## Secrets
- `argocd/applications/kestra/minio-credentials-sealedsecret.yaml` is sealed with a **placeholder** certificate. Reseal with the cluster’s SealedSecrets public key before syncing:
  ```bash
  kubeseal --controller-name sealed-secrets \
    --controller-namespace sealed-secrets \
    --fetch-cert > /tmp/sealed-secrets.pem

  kubectl create secret generic kestra-minio-creds \
    --namespace minio \
    --from-literal accesskey=<ROOT_USER> \
    --from-literal secretkey=<ROOT_PASSWORD> \
    --from-literal config.env=$'MINIO_ROOT_USER=<ROOT_USER>\nMINIO_ROOT_PASSWORD=<ROOT_PASSWORD>' \
    --dry-run=client -o yaml \
  | kubeseal --cert /tmp/sealed-secrets.pem -o yaml > argocd/applications/kestra/minio-credentials-sealedsecret.yaml
  ```
- The secret includes reflector annotations so the creds appear in the `kestra` namespace for the Helm chart and bucket job.

## Local validation
- `kustomize build argocd/applications/kestra`
- `helm template kestra kestra/kestra --version 1.0.18 -f argocd/applications/kestra/kestra-values.yaml --namespace kestra`
- `kubectl apply --dry-run=client -k argocd/applications/kestra`

## Access
- Tailnet hostname: `kestra` (via tailscale operator).
- Service port: 80 (LB) → 8080 (chart service).

## Upgrades
- Bump the chart version in `kustomization.yaml` and test with the validation commands above.
- Rotate MinIO credentials by re-sealing `minio-credentials-sealedsecret.yaml` and re-syncing the app.

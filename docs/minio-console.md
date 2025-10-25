# MinIO Console Operations

## Background
MinIO no longer ships community console images and distributes the UI as source-only artifacts beginning with the September 2025 releases. The upstream console repository now requires you to build binaries yourself (for example, release v2.0.4 is the latest tagged version used in this rollout).citeturn13search1turn13search0

## Build and Publish the Internal Image
1. Set the desired tag (defaults to the current commit SHA) and optionally override the console version:
   ```bash
   MINIO_CONSOLE_VERSION=v2.0.4 scripts/build-minio-console.sh <tag>
   ```
2. The script runs a `docker buildx --platform linux/amd64` build using `containers/minio-console/Dockerfile`, compiles the upstream Go module, and pushes `registry.ide-newton.ts.net/lab/minio-console:<tag>`.
3. If MinIO publishes a new console release, bump `MINIO_CONSOLE_VERSION` in the Dockerfile and script, rebuild, and update the deployment image.

## Provision Console Credentials
### Create a Scoped MinIO User
Use the existing `mc` administration tooling against the `observability` tenant to create a console-only user and policy. Adjust bucket scopes as needed for production:
```bash
mc admin user add observability/ console <GENERATED-SECRET>
mc admin policy create observability/ consoleAdmin admin.json
mc admin policy attach observability/ consoleAdmin --user console
```
The upstream console README documents the default admin-style policy; treat it as a starting point and trim permissions for least privilege.citeturn21view0

### Seal the Environment Variables
1. Install `kubeseal` and ensure the sealed-secrets controller public certificate is available (either via `kubeseal --fetch-cert` or the saved PEM file).
2. Run the generator from the repo root to emit all three sealed secrets, including the console env secret:
   ```bash
   bun run scripts/generate-observability-minio-secrets.ts --print-values
   ```
   The script now creates `argocd/applications/minio/observability-minio-console-secret.yaml` alongside the existing MinIO secrets with fresh access/secret keys plus PBKDF inputs matching the console defaults.
3. Commit the updated sealed secrets once resealed with production credentials. The committed placeholder is intentionally empty; replace it before deploying.

## Deploy and Verify
1. Render the manifests to confirm the new resources are valid:
   ```bash
   kustomize build argocd/applications/minio
   ```
2. After Argo CD syncs, verify the pods and services:
   ```bash
   kubectl -n minio get deploy,svc observability-minio-console observability-minio-console-tailscale
   ```
3. Confirm the Tailscale load balancer receives a hostname via the operator-managed `loadBalancerClass: tailscale` service.citeturn22view0

## Credential Rotation
1. Re-run the sealed-secret generator to mint new MinIO console credentials and PBKDF material.
2. Update the console user password in MinIO (`mc admin user svcacct reset` or policy-specific workflow) and reseal the secret.
3. Trigger an Argo CD sync. The Deployment consumes the new secret on the next rollout, and the Tailscale load balancer keeps the DNS name stable.

## Operational Notes
- Document real credentials outside of Git and rotate them if the console binary is regenerated.
- If the upstream repository changes build requirements (for example, a new Go toolchain), update the Dockerfile base image accordingly before the next release.
- Leave a reminder in the deployment notes to reseal the console secret with the production public key during the final rollout review.

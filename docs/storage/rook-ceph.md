# Rook-Ceph RGW deployment

## What we ship
- ArgoCD app: `rook-ceph` (namespace `rook-ceph`, sync-wave -1) renders the Rook operator and cluster charts pinned to `v1.18.7` from `https://charts.rook.io/release`.
- CephCluster runs with mons=3, mgrs=2, msgr2 enabled, host data dir `/var/lib/rook`, and discovers non-boot devices matching `sd[b-z]`, `vd[b-z]`, or `nvme*`.
- Object store: `objectstore` (RGW service `rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80`, pools replicated size=3, `preservePoolsOnDelete=true`).
- Bucket + user: sealed secret `rook-ceph-rgw-loki` (mirrored into `observability`), deterministic access keys, and a PostSync job `rook-ceph-rgw-loki-bucket` that waits for RGW and creates the `loki-data` bucket.
- Workload integration: Loki now points to the RGW endpoint using the same credentials; MinIO stays deployed for other tenants until follow-up migration.

## Health & validation
- ArgoCD status: `kubectl -n argocd get app rook-ceph`
- Ceph CRs: `kubectl -n rook-ceph get cephcluster,cephobjectstore,cephobjectstoreuser`
- Cluster health (toolbox): `kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph status`
- Bucket hook: `kubectl -n rook-ceph logs job/rook-ceph-rgw-loki-bucket`
- RGW smoke test:
  ```bash
  kubectl -n rook-ceph port-forward svc/rook-ceph-rgw-objectstore 8080:80
  export AWS_ACCESS_KEY_ID=<from rook-ceph-rgw-loki>
  export AWS_SECRET_ACCESS_KEY=<from rook-ceph-rgw-loki>
  aws --endpoint-url=http://localhost:8080 s3 ls
  ```
- Observability: `kubectl -n observability get pods` and check Loki ingester logs for S3 errors.

## Secrets & endpoints
- RGW credentials live in `rook-ceph` as a `SealedSecret` named `rook-ceph-rgw-loki`; reflector annotations mirror it into `observability`.
- Generated keys are also captured in `argocd/applications/observability/rook-ceph-rgw-secret.yaml` for declarative reuse.
- Endpoint: `http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80`
- Bucket: `loki-data`, Region: `us-east-1`

## Loki migration / rollback
- Current config (`argocd/applications/observability/loki-values.yaml`) uses the RGW endpoint, path-style S3, and the RGW access keys.
- Rollback to MinIO: revert `loki-values.yaml` to the MinIO endpoint `observability-minio.minio.svc.cluster.local:9000` and the MinIO credentials from `observability-minio-credentials`, then sync the `observability` app.
- MinIO jobs/secrets remain untouched; no data is deleted by this change.

## Operational notes
- Rook toolbox is enabled for on-cluster troubleshooting.
- Pools are `preservePoolsOnDelete=true` to protect data across app deletions.
- Storage assumes dedicated raw devices (no PVC-backed OSDs). If nodes lack spare disks, update `cephClusterSpec.storage` before syncing to avoid stuck OSDs.
- ServiceMonitors and alert rules are enabled via the chart; Prometheus should discover RGW/mgr endpoints automatically.

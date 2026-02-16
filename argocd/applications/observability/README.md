# Observability object storage (Ceph RGW)

Observability uses Ceph RGW object storage, not MinIO.
Loki, Mimir, and Tempo read S3 credentials and endpoint from secret `rook-ceph-rgw-loki` in the `observability` namespace.

## Sources of truth

1. `argocd/applications/observability/rook-ceph-rgw-loki.yaml`
2. `argocd/applications/observability/loki-values.yaml`
3. `argocd/applications/observability/mimir-values.yaml`
4. `argocd/applications/observability/tempo-values.yaml`

## Rotate RGW credentials

1. Re-seal `argocd/applications/observability/rook-ceph-rgw-loki.yaml` with the active sealed-secrets key.
2. Commit and sync `observability`.
3. Restart components if needed:

```bash
kubectl -n observability rollout restart deploy observability-loki-loki-distributed-distributor
kubectl -n observability rollout restart deploy observability-tempo-distributor
kubectl -n observability rollout restart deploy observability-mimir-distributor
```

## Validate

```bash
kubectl -n observability get secret rook-ceph-rgw-loki
kubectl -n observability get pods
kubectl -n argocd get app observability
```

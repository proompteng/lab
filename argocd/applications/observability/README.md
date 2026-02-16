# Observability object storage (Ceph RGW)

Observability uses Ceph RGW object storage, not MinIO.
Loki, Mimir, and Tempo read S3 credentials and endpoint from secret `rook-ceph-rgw-loki` in the `observability` namespace.

## Sources of truth

1. `argocd/applications/observability/rook-ceph-rgw-loki.yaml`
2. `argocd/applications/observability/loki-values.yaml`
3. `argocd/applications/observability/mimir-values.yaml`
4. `argocd/applications/observability/tempo-values.yaml`

## Required buckets

- `loki-data`
- `tempo-traces`
- `mimir-blocks`
- `mimir-alertmanager`
- `mimir-ruler`

These buckets must exist in RGW before the workloads can start successfully.

## Create buckets (Ceph RGW)

List buckets:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- radosgw-admin bucket list --rgw-zone objectstore
```

Create a missing bucket using `mc` + a temporary `port-forward`:

```bash
ACCESS_KEY="$(kubectl -n rook-ceph get secret rook-ceph-object-user-objectstore-loki -o jsonpath='{.data.AccessKey}' | base64 -d)"
SECRET_KEY="$(kubectl -n rook-ceph get secret rook-ceph-object-user-objectstore-loki -o jsonpath='{.data.SecretKey}' | base64 -d)"

kubectl -n rook-ceph port-forward svc/rook-ceph-rgw-objectstore 19000:80

mc alias set ceph http://127.0.0.1:19000 "$ACCESS_KEY" "$SECRET_KEY" --api S3v4
mc mb ceph/mimir-ruler
```

## Tailscale access

Observability is exposed over Tailscale using `Ingress` resources (not `Service` LoadBalancers) so it works under PodSecurity `baseline`.

- Grafana: `grafana.ide-newton.ts.net`
- Loki gateway: `loki.ide-newton.ts.net`
- Mimir nginx: `mimir.ide-newton.ts.net`
- Tempo gateway: `tempo.ide-newton.ts.net`

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

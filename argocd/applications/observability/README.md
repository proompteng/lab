# Observability object storage (Ceph RGW)

Observability uses Ceph RGW object storage, not MinIO.
Loki, Mimir, and Tempo read S3 access credentials from secret `rook-ceph-rgw-loki` in the `observability`
namespace.
That secret should be a reflected copy of the Rook-managed source secret
`rook-ceph-object-user-objectstore-loki` in namespace `rook-ceph`, not a hand-sealed credential copy.
Keep the RGW endpoint explicit in Helm values; it is not sourced from the reflected secret. Mimir and Tempo use the internal
TLS endpoint `rook-ceph-rgw-tls.rook-ceph.svc:443` with `insecure: false` and TLS server name
`ceph.k8s.proompteng.ai`. Loki uses `rook-ceph-rgw-objectstore.rook-ceph.svc:80`.
Mimir 3.2 uses normal rolling updates for ingesters, store gateway, compactor, and Alertmanager. Follow the
[Mimir 3.2 rollout](../../../docs/runbooks/mimir-3-2-upgrade.md) for the native configuration gate, ordered sync waves,
and live acceptance. The bundled Kafka broker alone retains `OnDelete` pending its separate upgrade.
The [Mimir recovery procedure](../../../docs/runbooks/mimir-rgw-tls-recovery.md) is historical guidance for
Mimir 3.1.2/chart 6.1.0; its process-reload helper deliberately rejects newer images and rolling strategies. The
[compatibility runbook](../../../docs/runbooks/ceph-rgw-sigv4-compatibility.md) documents the verified TLS path.
Its Tempo 2 buffer-reload procedure is historical and does not apply to the production Tempo 3 deployment.

Tempo 3 owns production ingestion, queries, and compaction. The compatibility Services preserve the original
Tempo distributor, gateway, and query-frontend addresses; do not remove them while clients use those names.
See the [Tempo migration runbook](../../../docs/runbooks/tempo-3-migration.md) for buffer-drain and recovery evidence.

## Sources of truth

1. `argocd/applications/rook-ceph/rook-ceph-objectstore-loki-user.yaml`
2. `argocd/applications/rook-ceph/rook-ceph-object-user-objectstore-loki-reflector-source.yaml`
3. `argocd/applications/observability/rook-ceph-rgw-loki-reflected-secret.yaml`
4. `argocd/applications/observability/loki-values.yaml`
5. `argocd/applications/observability/mimir-values.yaml`
6. `argocd/applications/observability/tempo-v3-values.yaml`

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
ACCESS_KEY="$(kubectl -n observability get secret rook-ceph-rgw-loki -o jsonpath='{.data.AccessKey}' | base64 -d)"
SECRET_KEY="$(kubectl -n observability get secret rook-ceph-rgw-loki -o jsonpath='{.data.SecretKey}' | base64 -d)"

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

## Reflect RGW credentials

1. Keep `CephObjectStoreUser/loki` and the source secret annotation manifests owned by the `rook-ceph` app.
2. Keep `rook-ceph-rgw-loki` in `observability` as a reflector target, not a hand-managed secret.
3. Keep the original RGW buckets (`loki-data`, `tempo-traces`, `mimir-blocks`, `mimir-alertmanager`,
   `mimir-ruler`) as the active storage path.
4. Restart components if needed:

```bash
kubectl -n observability rollout restart deploy observability-loki-loki-distributed-distributor
kubectl -n observability rollout restart deploy observability-tempo-v3-distributor
kubectl -n observability rollout restart deploy observability-mimir-distributor
```

## Validate

```bash
kubectl -n observability get secret rook-ceph-rgw-loki
kubectl -n observability get pods
kubectl -n argocd get app observability
```

## Cluster metrics

The observability app owns the cluster metrics pipeline used for ARC runner sizing and shared-storage diagnosis:

- `observability-kube-state-metrics`: Kubernetes object state and request/limit/allocatable metrics, plus
  CloudNativePG backup and scheduled-backup timestamps.
- `observability-cluster-metrics-alloy`: scrapes kube-state-metrics, kubelet, every CloudNativePG instance, the Ceph
  manager, Bayn's bounded service metrics, and Tengri's bounded control-plane metrics; it applies metric allowlists,
  including logical-slot WAL retention and pod-level `/dev/rbd*` I/O only, before remote-writing to Mimir.
- `arc-runner-capacity-dashboard`: Grafana dashboard for ARC CPU, memory, pending pods, and requested CPU saturation.
- `bayn-cycle-operations-dashboard`: Grafana dashboard for current trading readiness, execution authority, cycle
  reason and phase, session timing, economic evidence, accounting coverage, safety freshness, and replica-reduced
  lifecycle history. Running accounting is distinct from immutable terminal profit, cost, and return evidence; missing
  terminal evidence is never displayed as zero profit.
- `graf-mimir-rules`: records Torghut PostgreSQL and Ceph pressure baselines and alerts on Buzz relay/Redis/CNPG
  health, stale Buzz backups, Tengri availability and guest failures, missing telemetry, low PVC capacity, WAL archive
  backlog, logical-slot WAL retention, forced checkpoints, Ceph slow operations, scrub debt, and OSD latency.

Validate the Mimir tenant after sync:

```bash
kubectl -n observability port-forward svc/observability-mimir-gateway 19090:80
curl -fsS -G -H 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=count(container_cpu_usage_seconds_total{namespace="arc"})' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl -fsS -G -H 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=count(kube_pod_container_resource_requests{namespace="arc"})' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl -fsS -G -H 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=count(up{job="cnpg-postgres"})' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl -fsS -G -H 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=ceph_storage:osd_commit_latency_ms:max' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl -fsS -G -H 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=topk(10, ceph_storage:rbd_pod_write_bytes_per_second:rate5m)' \
  http://127.0.0.1:19090/prometheus/api/v1/query
```

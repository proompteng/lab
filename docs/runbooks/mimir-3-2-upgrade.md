# Mimir 3.2 upgrade

All queriers must already run Mimir 3.1 before enabling 3.2 remote execution.
Capture current Pod and PVC identities, healthy partition-ring ownership,
fresh remote-write samples, and a nonempty query against object-store history.

Render chart 6.2.0 with Helm 3 and preserve every immutable StatefulSet claim
template. The Alertmanager template is classless and requests 1Gi; its bound
PVC uses `rook-ceph-block`. Do not replace that template with a new storage
class or size. Keep the existing S3 buckets, credentials, and verified TLS
endpoint. The bundled Kafka retains its existing image and maintenance hold
until its separate broker upgrade is accepted.

GitOps applies the configuration first. The native Mimir `-modules` Job loads
and validates that exact configuration, then exits before starting services.
Use the normal whole-Application sync. Argo CD 3.5 retains hooks when
`ApplyOutOfSyncOnly=true`; syncing an explicitly selected resource subset can
skip hooks and must not be used for this upgrade. Verify the native Job's
successful result in the actual sync operation. Do not proceed past a failed
check. Roll the ingesters through the normal
StatefulSet controller, one ordinal at a time. Store gateway, compactor, and
Alertmanager follow in separate sync waves after earlier workloads are Ready.
Their temporary `OnDelete` holds are removed by this change.

Require every Mimir process on 3.2.0, the same PVC UIDs, healthy partition and
component rings, no new WAL corruption or failed uploads, fresh remote-write
samples, and preserved historical queries. Check ruler loading, Alertmanager
configuration and state persistence, and a completed compaction run.

If a rollout fails, preserve Kafka records, PVCs, and object-store blocks.
Correct the failing configuration through GitOps; never force-delete stateful
resources to clear a rollout. Consult the running-version release notes before
considering a downgrade after new binaries have written state.

Upstream: [Mimir 3.2 release notes](https://grafana.com/docs/mimir/latest/release-notes/v3.2/).

# Recover Mimir RGW uploads without remounting its storage

This procedure applies only to the Mimir 3.1.2/chart 6.1.0 recovery. Current
Mimir 3.2 uses the [ordered rolling upgrade procedure](mimir-3-2-upgrade.md).
Do not use the historical process-reload helper against rolling StatefulSets
or newer binaries; its version and strategy checks must remain enforced.

Mimir 3.1.2's MinIO HTTP signer is incompatible with Ceph 20.2.4. The
[RGW compatibility runbook](ceph-rgw-sigv4-compatibility.md) describes the verified internal TLS endpoint and
certificate. This procedure changes the transport while preserving Mimir's Pods, PVCs, credentials, and buckets.

## Stage the configuration through GitOps

The Mimir 6.1.0 chart puts its shared configuration checksum on the bundled Kafka StatefulSet, even though Kafka
does not use the S3 settings. A normal configuration rollout therefore restarts the single Kafka broker and Mimir's
PVC consumers. While storage maintenance is paused, use the native `OnDelete` strategy to stage the configuration:

- Set `ingester.statefulStrategy`, `alertmanager.statefulStrategy`, `compactor.strategy`, and
  `store_gateway.strategy` to `type: OnDelete` in the chart values.
- Apply `mimir-kafka-preserve-buffer.patch.yaml` through Kustomize. It sets Kafka's `updateStrategy` to `OnDelete`
  and explicitly clears `rollingUpdate`; omission alone can retain the API server's old default and reject the update.
- Set all three S3 sections to `rook-ceph-rgw-tls.rook-ceph.svc:443`, `insecure: false`, and
  `http.tls_server_name: ceph.k8s.proompteng.ai`.

Render the current chart and verify all five StatefulSets use `OnDelete`, with Kafka's `rollingUpdate: null` deletion
marker. A server dry run must accept all five and return `updateStrategy: {type: OnDelete}`.
Include the production Kustomize patches and match the existing Argo sync modes: compactor, ingester, Kafka, and
store gateway use `Replace=true`; alertmanager uses server-side apply. Require the same StatefulSet UIDs and PVC
templates in the dry-run responses. Do not add a forced delete/recreate operation.
Images and PVC templates must remain unchanged. After merge, let Argo reconcile; verify the original Pod and
PVC/PV identities remain intact and the TLS ConfigMap has reached each existing Pod. Stateless components roll
through their existing Deployment strategies. Keep the Kafka process untouched throughout recovery.

## Reload one Mimir container at a time

Use `scripts/cluster-upgrades/mimir-container-reload.py`. Its default mode is a read-only plan; execution requires
the exact Pod UID, current container ID, desired `mimir.yaml` SHA-256, process start-time ticks, and node boot ID.
Record these against the running container before execution. Read the process identity through its exact runtime
container ID and host PID; never infer it from a process name alone or print expanded configuration or credentials.

The helper appends a digest-pinned ephemeral container targeting the selected Mimir container's PID namespace.
It runs as Mimir's UID/GID `10001:10001` without elevated capabilities, verifies the command, projected configuration,
boot ID and PID 1 start-time ticks, then sends one SIGTERM. This preserves the existing Pod and mounted volumes.
The helper's bounded wait governs acceptance. Direct SIGTERM does **not** start Kubernetes' Pod-deletion grace timer.
Do not add a forced signal when the wait expires.

Process these targets sequentially:

1. `observability-mimir-ingester-0`, then `-1`, then `-2`.
2. `observability-mimir-store-gateway-0`.
3. `observability-mimir-compactor-0`.
4. `observability-mimir-alertmanager-0`.

Before each target, require the guarded StatefulSets and Kafka to be Ready, an available target PDB disruption,
unchanged target identity, and healthy peers. Afterward, require the same Pod/PVC/PV identities, exactly one clean
container restart, a new container ID and start time, and HTTP `/ready` returning 200. Recheck Kafka and peer
identities before proceeding.

Keep a single operator host for the sequence. The helper's local process lock prevents concurrent invocations on
that host and rejects unfinished peer helpers; it does not reserve a Kubernetes eviction budget across hosts.

For each ingester, also verify Kafka consumption catches up, the partition/ring state recovers, current metrics
queries work, and the exact blocks recorded as unshipped before recovery are present in the original bucket.
Successful new uploads or a reset error counter alone do not prove that retained blocks recovered. Record these
functional checks separately from the helper's process-reload receipt.

Mimir's normal SIGTERM path stops its services and closes TSDBs. With the current default
`blocks-storage.tsdb.flush-blocks-on-shutdown=false`, it reuses incomplete blocks on restart. Do not use
`/ingester/shutdown` for this transition: that endpoint forces a flush against the old S3 configuration and changes
ring shutdown behavior. See the pinned [3.1.2 TSDB configuration](https://github.com/grafana/mimir/blob/mimir-3.1.2/pkg/storage/tsdb/config.go)
and [ingester shutdown implementation](https://github.com/grafana/mimir/blob/mimir-3.1.2/pkg/ingester/ingester_http.go).

The singleton store gateway can briefly interrupt historical queries; the compactor pauses compaction; the
alertmanager pauses alert processing. Preserve their local state and verify each component before the next restart.

## Finish or stop

Stop after any unexpected identity, peer-health, process-exit, TLS, or data-recovery result. Keep the original Pods
and volumes and inspect the receipt; do not repeat a failed helper blindly, delete a Pod, weaken signature checks,
or discard an unshipped block.

After retained blocks and functional acceptance are complete, restore ordinary StatefulSet rollout strategies in a
separate reviewed GitOps change when storage maintenance is safe. Removing the guards can replace Pods whose
template checksums changed, including Kafka. Schedule that step explicitly; an in-place process reload does not
update the Pod's StatefulSet revision label or migrate its existing Ceph client key.

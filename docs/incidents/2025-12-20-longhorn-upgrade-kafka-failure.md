# Incident Report: Longhorn 1.10.1 Upgrade, Kafka Mount Failure, API Instability

- **Date**: 20 Dec 2025
- **Detected by**: Argo CD sync failure, Kafka `FailedMount` events
- **Reported by**: gregkonush
- **Services Affected**: Longhorn (storage), Kafka (`kafka` namespace), Temporal, Kubernetes API stability
- **Severity**: High - Kafka broker unavailable; cluster control-plane intermittently unavailable; Temporal down

## Impact Summary

- Longhorn upgrade to 1.10.1 failed in Argo CD due to invalid CRD conversion fields.
- Kubernetes API was intermittently unavailable (connection refused / unexpected EOF), delaying remediation.
- Kafka broker `kafka-pool-a-2` was stuck `ContainerCreating` due to filesystem corruption on its Longhorn PVC.
- Temporal outage due to Elasticsearch data corruption and failed volume attachments (incident ongoing).
- Torghut ClickHouse/ClickHouse Keeper resources failed to apply due to manifest schema mismatch.
- MinIO operator sync blocked by a CRD storedVersion mismatch (`policybindings.sts.min.io`).
- Temporal intermittently failed to read namespaces because Cassandra could not meet LOCAL_QUORUM after node shrink.
- MinIO observability tenant pods stuck Pending due to Longhorn attach timeout on `pvc-e438ed00...`.

## Timeline (Pacific Time)

| Time | Event |
|------|-------|
| 2025-12-20 11:39:36 | Argo CD reports Longhorn sync failure: CRDs invalid because `spec.conversion.strategy` missing while conversion webhook config present. |
| 2025-12-20 ~11:49 | Argo CD still OutOfSync; Kubernetes API intermittently refuses connections during sync/patch attempts. |
| 2025-12-20 12:22 | Kafka pod `kafka-pool-a-2` reports `FailedMount`: fsck detects filesystem errors and requires manual repair. |
| 2025-12-20 ~12:30 | Manual fsck executed on Longhorn device for PVC `pvc-40d29f68-1901-457b-8313-1ca1310861c6`. |
| 2025-12-20 ~12:40 | Stale VolumeAttachment cleared; Kafka pod reattached to PVC and became Ready. |
| 2025-12-20 ~12:50 | Temporal Elasticsearch (`elasticsearch-master-0`) reports I/O errors and attach timeouts on PVC `pvc-a794ca22-df7d-4053-9cfb-fb2a4211794a`. |
| 2025-12-20 ~13:00 | Temporal set to single-node Cassandra and ES; ES PVCs deleted and recreated. |
| 2025-12-20 ~13:10 | ES single-node bootstrap adjustments applied; readiness probe relaxed to `yellow`. |
| 2025-12-20 ~13:25 | Torghut ClickHouse/ClickHouse Keeper manifests fail Argo CD apply due to `podTemplates`/`volumeClaimTemplates` schema mismatch. |
| 2025-12-20 ~13:30 | Torghut manifests updated to move templates under `spec.templates` and referenced by name in cluster-level templates. |
| 2025-12-20 ~14:10 | MinIO CRD sync fails: `policybindings.sts.min.io` has `status.storedVersions` set to `v1beta1` but `spec.versions` no longer includes `v1beta1`. |
| 2025-12-20 ~14:20 | Temporal frontend errors with `Cannot achieve consistency level LOCAL_QUORUM` after Cassandra downscaled. Removed dead nodes from ring and restarted Temporal services. |
| 2025-12-20 ~14:35 | MinIO observability tenant PVC `pvc-e438ed00...` could not attach (Longhorn replica stuck on kube-worker-29). Deleted the stuck replica and volume attached. |

## Root Cause

- **Longhorn upgrade failure**: Existing Longhorn CRDs contained stale `spec.conversion.webhookClientConfig` without `spec.conversion.strategy: Webhook`. Kubernetes rejected the updated CRDs during sync.
- **Kafka mount failure**: Filesystem corruption on the Longhorn volume backing `data-kafka-pool-a-2` required a manual `fsck`. Automated fsck could not repair orphaned inodes.
- **Temporal outage**: Elasticsearch data path on `elasticsearch-master-0` returned I/O errors, plus Longhorn attachment ticket churn blocked recovery until the data volume was re-created and ES was reconfigured for single-node bootstrap.
- **Torghut ClickHouse**: ClickHouse Keeper CRD rejected `spec.configuration.clusters[].templates.podTemplates` because the schema expects template names there, not inline templates.
- **MinIO CRD mismatch**: The MinIO operator upgrade dropped `v1beta1` from `spec.versions` while the cluster still reports `status.storedVersions: [v1beta1]`, causing the CRD update to be rejected.
- **Temporal Cassandra ring**: Cassandra was reduced to a single node but still listed two dead nodes in the ring. With `replicationFactor: 1`, LOCAL_QUORUM still required responses from tokens owned by down nodes.
- **MinIO attach failure**: Longhorn volume for the observability tenant had a replica on kube-worker-29 without a valid instance manager, blocking attach to kube-worker-18.

## Contributing Factors

- Argo CD autosync applied new CRDs while legacy conversion fields were still present.
- Kubernetes API instability (connection refused / unexpected EOF) interrupted remediation steps.
- Kafka pod rescheduled to a different node, causing multi-attach conflicts until the stale VolumeAttachment was removed.
- Temporal Elasticsearch StatefulSet kept previous multi-node bootstrap settings while replicas were reduced to 1, causing `MasterNotDiscoveredException` and `cluster.initial_master_nodes` conflicts until the config was updated.

## Remediation Actions

1. Patched Longhorn CRDs to remove `spec.conversion` blocks (defaults to `strategy: None`).
2. Ran `e2fsck -f -y` on `/dev/longhorn/pvc-40d29f68-1901-457b-8313-1ca1310861c6` from a privileged pod on the node hosting the volume.
3. Removed stale VolumeAttachment and reattached the PVC to the Kafka node.
4. Verified `kafka-pool-a-2` Ready and mounted volume healthy.
5. Rebuilt Temporal Elasticsearch storage (delete PVCs) and reconfigured ES/Cassandra to single-node.
6. Applied ES single-node bootstrap fixes and readiness adjustments; restarted ES pod.
7. Updated Torghut ClickHouse and ClickHouse Keeper manifests to define templates under `spec.templates` and reference them by name.
8. Reintroduced the `v1beta1` CRD version for MinIO `policybindings.sts.min.io` (served, non-storage) to satisfy storedVersions.
9. Removed dead Cassandra nodes from the ring, then restarted Temporal services to clear LOCAL_QUORUM errors.
10. Deleted the stuck Longhorn replica for the MinIO observability PVC so the volume could attach and the pod could start.

## Manual Interventions (Commands and Hacks)

These were executed manually during the incident to force recovery.

### Longhorn / CRDs

```bash
# Remove invalid CRD conversion blocks
for crd in nodes.longhorn.io volumes.longhorn.io backingimages.longhorn.io backuptargets.longhorn.io engineimages.longhorn.io; do
  kubectl patch crd "$crd" --type=json -p='[{"op":"remove","path":"/spec/conversion"}]' || true
done
```

### Jangar PVC resize (drifted from Git until PR merged)

```bash
kubectl -n jangar patch pvc jangar-workspace --type merge -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
kubectl -n jangar rollout restart deploy/jangar
```

### Kafka fsck + attach cleanup

```bash
# fsck on Longhorn device (kube-worker-15)
kubectl -n longhorn-system apply -f - <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: fsck-pvc-40d29f68
  namespace: longhorn-system
spec:
  nodeName: kube-worker-15
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: fsck
      image: alpine:3.20
      securityContext:
        privileged: true
      command:
        - sh
        - -c
        - |
          set -eux
          apk add --no-cache e2fsprogs
          e2fsck -f -y /dev/longhorn/pvc-40d29f68-1901-457b-8313-1ca1310861c6
      volumeMounts:
        - name: dev
          mountPath: /dev/longhorn
  volumes:
    - name: dev
      hostPath:
        path: /dev/longhorn
POD

# Clear stale CSI VolumeAttachment
kubectl delete volumeattachment csi-52b1b23e4a807061e8e0531fc07bcd0e945e3ecf4f5a2ac099bd67361d21b8ff
```

### Temporal: pause autosync, single-node, and storage reset

```bash
# Disable Temporal autosync by switching ApplicationSet automation to manual
kubectl -n argocd patch applicationset platform --type json \
  -p='[{"op":"replace","path":"/spec/generators/0/list/elements/21/automation","value":"manual"}]'

# Scale down ES + Cassandra
kubectl -n temporal scale sts elasticsearch-master --replicas=0
kubectl -n temporal scale sts temporal-cassandra --replicas=0

# Nuke ES PVCs (data reset)
kubectl -n temporal delete pvc -l app=elasticsearch-master

# Scale up to single node
kubectl -n temporal scale sts temporal-cassandra --replicas=1
kubectl -n temporal scale sts elasticsearch-master --replicas=1
```

### Temporal: ES bootstrap and readiness fixes

```bash
# Apply manifest changes (single-node Cassandra/ES + readiness)
argocd app sync temporal

# Force ES env updates and readiness relaxation via kubectl apply
kubectl apply -f /tmp/temporal-elasticsearch-master.json
kubectl apply -f /tmp/temporal-cassandra.json

# Remove discovery.type after conflict with cluster.initial_master_nodes
kubectl -n temporal patch sts elasticsearch-master --type json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/0/env/11"}]'

# Restart ES pod to pick up env changes
kubectl -n temporal delete pod elasticsearch-master-0
```

### Torghut: ClickHouse manifest schema fix

```bash
# Move inline templates to top-level spec.templates and reference by name
argocd app sync torghut
# or apply directly when API is stable
kubectl -n torghut apply -f argocd/applications/torghut/clickhouse/clickhouse-keeper.yaml
kubectl -n torghut apply -f argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml
```

### MinIO: policybindings CRD storedVersions fix

```bash
# Re-add v1beta1 to spec.versions so storedVersions can reconcile
kubectl apply -k argocd/applications/minio
```

### Temporal: Cassandra ring cleanup (LOCAL_QUORUM failures)

```bash
# Remove dead Cassandra nodes from ring after downscale
kubectl -n temporal exec temporal-cassandra-0 -- nodetool removenode 92d0e49d-055b-4c31-ad5e-ead768f49cf7
kubectl -n temporal exec temporal-cassandra-0 -- nodetool removenode 9f30c1f8-3c47-413d-96b8-5c14fe305444

# Restart Temporal services to pick up healthy persistence
kubectl -n temporal rollout restart deploy/temporal-frontend deploy/temporal-history deploy/temporal-matching deploy/temporal-worker deploy/temporal-web
```

### MinIO: observability tenant attach failure

```bash
# Remove stuck replica so volume can attach to kube-worker-18
kubectl -n longhorn-system delete replicas.longhorn.io pvc-e438ed00-eae4-456c-89c5-1fe0fc03fbcf-r-43c8733c
```

## Follow-up Actions

- **Upgrade guardrail**: Add a pre-upgrade step for Longhorn CRDs to normalize or remove stale conversion fields before chart upgrades.
- **Runbook**: Document a standard Longhorn fsck workflow for corrupted volumes (including attach/detach and VolumeAttachment cleanup).
- **Monitoring**: Add alerts for repeated `FailedMount` errors and for API server instability during Argo CD syncs.
- **Post-upgrade validation**: Verify Longhorn controller/daemonset health and Kafka ISR/under-replicated partitions after storage incidents.
- **Temporal hardening**: Add explicit single-node values in Git (ES `replicas`, `minimumMasterNodes`, `clusterHealthCheckParams`, Cassandra `cluster_size`) and document the required ES bootstrap env changes.
- **Torghut ClickHouse**: Add a validation check (CRD schema) in CI or pre-sync linting to catch invalid template nesting.
- **MinIO CRD upgrades**: Keep old CRD versions in `spec.versions` until storage migration removes them from `status.storedVersions`.
- **Temporal Cassandra downscales**: After reducing replicas, remove dead nodes from the ring to avoid LOCAL_QUORUM failures; document ring cleanup in the runbook.
- **MinIO observability**: Ensure Longhorn can place replicas on nodes with valid instance managers; avoid scheduling replicas onto tainted nodes without Longhorn managers.

## Lessons Learned

- Legacy CRD conversion fields can block upgrades; plan a normalization step in storage upgrades.
- Manual fsck remains a necessary recovery path for Longhorn-backed volumes when automated repair fails.
- Stale VolumeAttachments can prevent recovery when pods reschedule; cleanup should be part of the runbook.
- Reducing ES replicas to 1 requires matching bootstrap settings (`cluster.initial_master_nodes` and readiness threshold) or it will never elect a master.

## Relevant Commands

```bash
# Remove CRD conversion blocks
for crd in nodes.longhorn.io volumes.longhorn.io backingimages.longhorn.io backuptargets.longhorn.io engineimages.longhorn.io; do
  kubectl patch crd "$crd" --type=json -p='[{"op":"remove","path":"/spec/conversion"}]' || true
  done

# Manual fsck via privileged pod
kubectl apply -f - <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: fsck-pvc-40d29f68
  namespace: longhorn-system
spec:
  nodeName: kube-worker-15
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: fsck
      image: alpine:3.20
      securityContext:
        privileged: true
      command:
        - sh
        - -c
        - |
          set -eux
          apk add --no-cache e2fsprogs
          e2fsck -f -y /dev/longhorn/pvc-40d29f68-1901-457b-8313-1ca1310861c6
      volumeMounts:
        - name: dev
          mountPath: /dev/longhorn
  volumes:
    - name: dev
      hostPath:
        path: /dev/longhorn
POD

# Clear stale attachment if needed
kubectl delete volumeattachment <name>
```

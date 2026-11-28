# Rook-Ceph degraded triage

Use this runbook for read-only diagnosis on Galactic. Do not delete or restart pods, patch storage resources, shrink
PVCs, change Ceph flags or replica counts, or force PG repair, OSD removal, or RGW cleanup. Use the existing
[Galactic access path](galactic-kubernetes-access.md). Do not dump Secrets, keyrings, RGW user details, or object
contents into an incident record.

## Find the resource that made Argo degraded

```bash
set -o pipefail
ctx=galactic-tailscale # Use galactic-lan from the provider LAN.
kubectl config get-contexts "$ctx"
kubectl --context "$ctx" -n argocd get application rook-ceph -o json | jq '.status | {
  revision: .sync.revision, sync: .sync.status, health: .health.status,
  conditions: [.conditions[]? | .type],
  resources: [.resources[]? | select((.health.status // "Healthy") != "Healthy" or .status == "OutOfSync")
    | {kind, namespace, name, sync: .status, health: .health.status, message: .health.message}]
}'
kubectl --context "$ctx" -n rook-ceph get cephcluster,cephobjectstore
kubectl --context "$ctx" -n rook-ceph get deployments,daemonsets,pods,pdb -o wide
```

- `Synced/Degraded` is not manifest drift by itself. Argo's built-in
  [CephCluster check](https://github.com/argoproj/argo-cd/blob/v3.6.3/resource_customizations/ceph.rook.io/CephCluster/health.lua)
  reports both `HEALTH_WARN` and `HEALTH_ERR` as `Degraded`. The
  [CephObjectStore check](https://github.com/argoproj/argo-cd/blob/v3.6.3/resource_customizations/ceph.rook.io/CephObjectStore/health.lua)
  does the same for phase `Failure`. Diagnose the reported resource; do not suppress its health signal. If child
  health is missing from the Application status, inspect the Argo resource tree with your existing Galactic session
  (`argocd app get rook-ceph -N argocd -o tree=detailed`, without a refresh flag).
- For `OutOfSync` or a comparison error, check the revision and render it locally with Helm 3 and
  `kustomize build --enable-helm argocd/applications/rook-ceph`. Compare the affected fields, not entire live objects
  containing credentials. The [bootstrap ApplicationSet](../../argocd/applicationsets/bootstrap.yaml) already handles
  specific Rook-generated Secret and ConfigMap fields. Do not broaden those ignores.
- The Git-only audit did not identify the live cause of `Degraded`. It did find a tag-only CSI snapshotter override
  that renders as an empty image override in `rook-csi-operator-image-set-configmap`; the chart requires both a
  repository and a tag. If a CSI controller is unhealthy, check its actual sidecar image and pod status rather than
  assuming the tag in values is deployed. This change does not alter CSI images.

## Check quorum, OSDs, and PG recovery

In the same shell, use the existing toolbox (do not create one during triage):

```bash
toolbox() { kubectl --context "$ctx" -n rook-ceph exec deploy/rook-ceph-tools -c rook-ceph-tools -- "$@"; }

toolbox ceph status
toolbox ceph health detail
toolbox ceph quorum_status -f json | jq '{ quorum_names }'
toolbox ceph osd tree
toolbox ceph osd df tree
toolbox ceph osd perf
toolbox ceph pg stat
toolbox ceph pg dump_stuck
```

The GitOps baseline is three monitors on separate nodes, two managers, and six OSDs on two storage hosts. The pinned
chart supplies the monitor's `1000m` CPU / `1Gi` memory requests and `2Gi` memory limit. Repository values request
`500m` / `1Gi` for the manager (limit `4Gi`), and `1000m` / `8Gi` for each OSD (limit `12Gi`). Rook manages mon and
RGW eviction budgets and health-gates OSD drains with `managePodBudgets: true` and `osdMaintenanceTimeout: 30`.
Rook also creates the manager PDB with two managers. Check the live budgets and pod readiness rather than adding
overlapping PDBs or evicting around them.

- Check that three mons are in quorum, the active mgr has a ready standby, and all six OSDs are `up` and `in`.
- During recovery, compare two timestamped `ceph status` samples. Decreasing degraded/misplaced object counts and PGs
  returning to `active+clean` show progress; `active+clean+scrubbing` is still clean. For a stuck PG, use its ID from
  `dump_stuck` with `toolbox ceph tell <pgid> query` to see the acting OSDs and blocked state.
- Escalate loss of quorum, inactive/stale PGs, unfound objects, full/backfill-full OSDs, or recovery that makes no
  progress. With host-level size-2 replication on two storage hosts, losing one host removes a replica failure domain.
  Do not proceed with maintenance on the remaining one. Follow the
  [storage recovery runbook](galactic-storage-and-workload-recovery.md) for a separately authorized recovery.

The [CSI acceptance script](../../scripts/cluster-upgrades/storage-csi-acceptance.sh) is a read-only post-rollout check
for Ceph/CSI, attachments, and existing consumers, not an RGW acceptance test. The adjacent
`ceph-csi-remount.py` and `ceph-csi-taint-remount.py` helpers can mutate workloads and nodes; do not run them for triage.

## Check RGW and the artifact bucket

```bash
kubectl --context "$ctx" -n rook-ceph get deployment,pod -l app=rook-ceph-rgw,rook_object_store=objectstore -o wide
kubectl --context "$ctx" -n rook-ceph get endpointslices -l kubernetes.io/service-name=rook-ceph-rgw-objectstore -o json |
  jq '[.items[].endpoints[] | {node: .nodeName, ready: .conditions.ready}]'
kubectl --context "$ctx" -n agents get objectbucketclaim agents-artifacts \
  -o jsonpath='{.status.phase}{"\t"}{.spec.bucketName}{"\n"}'
toolbox ceph df detail

rgw() { toolbox radosgw-admin --rgw-realm=objectstore --rgw-zonegroup=objectstore --rgw-zone=objectstore "$@"; }
rgw bucket stats --bucket=agents-artifacts | jq '{ bucket, versioning, usage }'
rgw lc get --bucket=agents-artifacts
```

`objectstore` exposes port 80 (Beast listens on 8080), has two RGWs with Rook's preferred host anti-affinity, and uses
host-replicated metadata and data pools. STS is explicitly disabled. Compare ready endpoints, RGW error rates and
latency, bucket bytes/object counts, and free space in the RGW pools. If endpoints and Ceph are healthy but clients
time out or return 5xx, check gateway saturation, OSD tail latency, and the bucket index; distinguish this from S3
403 credential/policy failures. `Bound` on the claim is not evidence that the lifecycle update reached RGW.

The [Agents-owned claim](../../argocd/applications/agents/agents-artifacts-objectbucketclaim.yaml) keeps its bucket
and `Retain` StorageClass and is protected from Argo pruning and cascading Application deletion. RGW aborts unfinished
multipart uploads after 7 days. Only `runner-telemetry/` (the runner's heartbeat snapshots) is eligible for completed
object expiry after 14 days; noncurrent versions under that prefix expire 14 days after becoming noncurrent if
versioning is used. The Agents controller's default run retention is 7 days; neither that TTL nor the sample
`Artifact.spec.lifecycle.ttlDays` configures RGW. RGW processes the bucket rules asynchronously. Do not use the
telemetry prefix for durable objects. Caller-selected result, log, and evidence keys outside it are not expired by
this policy.

## Rollout and rollback boundaries

1. Before an authorized rollout, check Ceph/PG health and both RGW endpoints. Read the existing lifecycle
   configuration and check the affected prefix and incomplete uploads for anything that must be retained. Adding rules
   can make already-old data eligible on the next RGW scan, and Rook replaces the entire lifecycle configuration.
   If live rules exist that Git does not represent, stop and reconcile them in review first.
2. Verify `rook-ceph` at the reviewed `main` revision and the `rook-ceph-operator-config` allowlist contains
   `maxObjects,maxSize,bucketLifecycle`. This setting is operator-wide: verify that only trusted administrators can
   write OBCs. Do not enable `bucketPolicy` or `bucketOwner`. The Agents claim follows the generated `kargo/agents`
   revision through the [normal release path](../release-automation.md). After reconciliation, verify both rules
   with `lc get` and check that recent AgentRuns still publish and read back their expected artifacts.
3. To roll back, remove `spec.additionalConfig.bucketLifecycle` in a reviewed Agents GitOps change if there was no
   prior policy, or restore the prior reviewed rules. Keep the claim, its deletion guards, and StorageClass in place.
   Let Kargo deliver the rollback and verify that RGW reports no policy (or the restored rules) on the same bucket.
   Keep the Rook allowlist entry until this is verified; only remove the entry in a follow-up if no claim needs it.
   A policy rollback does not restore objects already expired or multipart parts already aborted.

Do not delete or recreate the claim, bucket, pools, or PVCs to roll back. Do not downgrade Rook/Ceph or bypass
their recovery gates. These steps do not authorize live writes or a rollout as part of triage.

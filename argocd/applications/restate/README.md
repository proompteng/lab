# Restate GitOps rollout notes

This application deploys the self-hosted Restate server and its private admin UI exposure.

## Operator and request-identity foundation rollout

This rollout installs the Restate Operator foundation but does not register, activate, or move any Bayn execution.
The root ApplicationSet creates two independently reconciled automated applications: `restate-operator-crds` and
`restate-operator`, whose chart is configured with `installCrds: false`. The operational order is CRDs first, operator
second: the CRD application must report `Synced` and `Healthy` before any `RestateDeployment` is committed. If the
operator application reconciles while its CRDs are still settling, hold the Bayn worker layer and verify that both
applications converge; do not create resources by hand.

The same GitOps revision mounts the sealed request-identity private key into the existing single-replica Restate
StatefulSet. That change replaces the Restate pod and can briefly make the control plane unavailable. Existing Bayn
execution remains on its legacy fail-closed owner during this foundation rollout, so this restart must not create a
second lifecycle writer or broker mutation path. The PVC, Restate metadata, and existing deployment registrations are
preserved.

After Argo reconciles `main`, verify the ordered foundation without printing the private key:

```sh
kubectl get application -n argocd restate-operator-crds restate-operator restate -o wide
kubectl get crd -n restate-operator restatedeployments.restate.dev -o name
kubectl rollout status deployment/restate-operator -n restate-operator --timeout=180s
kubectl rollout status statefulset/restate -n restate --timeout=300s
kubectl exec -n restate statefulset/restate -- test -s /var/run/secrets/restate/request-identity/private.pem
kubectl get restatedeployment -n bayn
```

Expected:

- both operator applications and `restate` are `Synced` and `Healthy`;
- the operator deployment and Restate StatefulSet complete rollout;
- the request-identity file exists and is non-empty without its contents entering logs;
- no Bayn `RestateDeployment` exists at this foundation layer;
- the existing Restate admin and ingress Services retain ready endpoints.

The same revision extends the auto-synced observability application with Restate server and operator scrapes. Its
configuration hash change replaces the single `observability-cluster-metrics-alloy` pod. A short scrape gap and a new
pod identity are expected; loss of the pre-existing Bayn, CNPG, Ceph, kubelet, or kube-state-metrics targets is not.
The two new unavailable alerts may remain pending for at most their two-minute evaluation window while Restate and the
operator converge.

Verify the collector rollout and both new targets without changing cluster state:

```sh
kubectl rollout status deployment/observability-cluster-metrics-alloy -n observability --timeout=180s
kubectl get pods -n observability -l app.kubernetes.io/name=observability-cluster-metrics-alloy -o wide
kubectl logs -n observability deployment/observability-cluster-metrics-alloy --since=10m | grep -E 'restate|error'
```

In Mimir or Grafana, require `up{job="restate-server"} == 1` and `up{job="restate-operator"} == 1`, then confirm the
pre-existing `bayn`, `cnpg-postgres`, `ceph-storage`, `kubelet`, `kubelet-cadvisor`, and `kube-state-metrics` jobs still
report `up == 1`. If the Alloy rollout fails or an existing target disappears, revert this foundation commit through a
normal PR. Argo will restore the prior Alloy configuration hash and alert rules; wait for the replacement collector to
become available and recheck every pre-existing target before resuming the worker layer.

If the operator or signing-key rollout does not converge, revert this foundation commit through a normal PR and let
Argo reconcile the prior StatefulSet. Before removing operator CRDs, prove that no `RestateDeployment` objects exist;
remove the operator application before its CRD application, and never manually delete a CRD that still has instances.
The rollback must leave the Restate PVC and prior service registrations intact. Recheck the StatefulSet, Services, and
admin API after the revert before resuming the Bayn worker layer.

## Resilience migration

Restate stays pinned at 1.7.2. `restate-0` and its retained RBD PVC seed the existing cluster; all nodes use
`RESTATE_AUTO_PROVISION=false` and stable StatefulSet addresses so scaling cannot create a second cluster.
Migration order is strict: protect the Rook `restate-snapshots` OBC, enable 30-minute snapshots with retention two,
and require all 24 partitions archived before replication changes. In Restate 1.7.2, `ARCHIVED=0` is the invalid-LSN
sentinel and must be treated as no snapshot; the bootstrap retries only missing/invalid partitions until every partition
has a positive archived LSN. RGW stores snapshots only; metadata/Raft and logs stay on
RBD. Host anti-affinity/`DoNotSchedule`, `minAvailable: 3`, and 60s/90s shutdown windows bound disruption; the PDB
therefore permits zero voluntary evictions until a separately reviewed post-rollout relaxation.
`restate-replication-migration` requires three ready nodes, one identical three-member Raft set, and archived snapshots
before `restatectl config set --replication 2 --yes`; it rejects mixed state and waits for all 24 logs plus two active
processors per partition. `default-replication` is initial-provisioning only.

Official contracts: [HA](https://docs.restate.dev/server/deploy/ha), [metadata](https://docs.restate.dev/server/deploy/metadata), and [snapshots](https://docs.restate.dev/server/deploy/snapshots).

The singleton layer includes a fail-closed PreSync rollback guard. If a later HA layer is reverted after replication
was raised, it performs Restate's documented shrink sequence while all three pods still exist and only permits the
StatefulSet downscale after replication is one, removable workers/log servers are drained, metadata is singleton, a
snapshot has trimmed historic nodesets, and all 24 partitions/logs reference only `restate-0`.
This HA layer omits that guard during normal operation; reverting this layer reintroduces the parent PreSync guard
before Argo can apply the singleton StatefulSet.

## Recovery proof and control-plane telemetry

The StatefulSet keeps an in-revision follower startup gate: `restate-0` starts normally, while `restate-1` and
`restate-2` cannot start the Restate process until the singleton seed reports positive archived snapshot LSNs for every
partition. `restate-1` requests snapshots for any missing partition while both followers wait. This keeps a direct
sync to the three-replica revision safe without relying on a previously merged Git revision or a PostSync hook that
cannot run until the StatefulSet is healthy. The followers then join the existing cluster with empty retained RBD PVCs
and bootstrap worker state from the snapshot repository as needed. A PDB
with `minAvailable: 3` blocks voluntary disruption during the replication migration; it must not be relaxed until
replication two and healthy three-node quorum are proven live.

`restate-replication-migration` is a PostSync hook and is the only component allowed to change the already-provisioned
cluster replication setting. It first requires all three stable node names to be alive and ready, all three metadata
servers to report the same three-member Raft configuration, and partition snapshots to remain archived. It then uses
the Restate 1.7.2-supported `restatectl config set --replication 2 --yes` operation. It refuses mixed or unexpected
replication state and succeeds only after all 24 logs are replication two and all 24 partitions have exactly two active
processors. A sealed idle log tail is accepted only when `logs describe --all --extra` proves its latest replicated
segment is replication two. On roll-forward after singleton rollback it reactivates only the exact retained
`restate-1`/`restate-2` node IDs (log storage read-write, worker active, metadata member) before readiness and rejects
unexpected identities. This is intentionally different from setting `default-replication`: Restate documents that the
default is only used when a cluster is initially provisioned and does not migrate existing logs or partitions.

## Recovery proof and control-plane telemetry

All three NodeCtl endpoints are scraped directly. Mimir covers node/quorum health, partition progress, snapshots, and
restore-drill freshness. Snapshot failures are aggregated once per Restate cluster rather than once per node. Recurring
operational monitoring uses these exported NodeCtl metrics; distributed SQL introspection is reserved for bounded,
operator-initiated troubleshooting because a recurring full-cluster scan competes with the control plane it observes.
The digest-pinned `restate-tools` drill opens all 24 RGW snapshots in isolated `emptyDir` storage and runs read-only SQL
without writing RGW or contacting production Restate. This proves snapshots, not metadata/log DR.

Do not use `restate_partition_applied_lsn_lag` as the workload-backlog alert. In Restate 1.7.2 it is a per-processor
replay-target gauge and replicated followers can retain non-zero values while the live partition table is fully caught
up. Inspect invocation and queue state with a bounded, operator-initiated SQL query only when exported metrics or a
runtime symptom requires troubleshooting.

Rollout is fail-closed. `restate-snapshot-restore-proof` is PostSync with a 30-minute deadline, so a failed offline
snapshot open keeps the Restate Application from completing rather than bypassing recovery proof; while snapshot upload
is still converging, the proof retries the isolated repository open until all 24 partitions are present. The proof and daily
drill each request 100m CPU/768Mi memory and are capped at 2 CPU/4096Mi while downloading the latest 24 snapshots into
ephemeral storage; expect bounded RGW/network reads but no object-store writes. The Alloy configuration hash change
restarts the single cluster-metrics collector, so require its rollout plus all pre-existing scrape jobs and all three
Restate NodeCtl targets to return before considering telemetry healthy.

If the PostSync proof fails, inspect the Job and its logs without printing OBC Secret values, verify fresh partition
snapshots exist, and fix forward; do not delete production Restate data or skip the hook. A failed daily drill is
visible through its CronJob status and Mimir alerts and should be rerun only through normal Kubernetes scheduling/GitOps
changes. Rollback of this layer is a normal reviewed Git revert: it removes the proof/drill resources and restores the
previous Alloy config/rules while the protected OBC and snapshots remain retained. The HA PDB intentionally stays
at `minAvailable: 3`; relaxing it is a separate post-rollout change only after live replication-two/quorum proof.

### Safe replacement and rollback

Before one-pod replacement require exact reviewed Argo source, three distinct healthy hosts, quorum/replication two,
fresh restore proof, Bayn `RestateDeployment` Ready, EXACT/zero unresolved/read-only/one owner; require full recovery.
The normal HA layer omits the parent singleton rollback guard. Reverting the HA layer reintroduces that PreSync guard,
which contracts replication, workers/log servers, metadata membership, and historic nodesets before Argo may downscale
the StatefulSet to one. Never bypass the guard with direct cluster edits or a direct manual scale-down.

## Admin UI exposure

`restate-admin-tailscale` exposes the Restate admin/UI port only through a layer-7 Tailscale Ingress. The operator
terminates tailnet TLS and forwards HTTP to the cluster-internal `restate` Service on admin port `9070`.

- Canonical tailnet URL: `https://restate.ide-newton.ts.net/`
- Tailscale hostname: `restate`
- Kubernetes Ingress: `restate-admin-tailscale`
- External port: `443`
- Restate backend: `restate` Service, `admin` / `9070`

The Ingress does not enable Tailscale Funnel, so the admin UI remains private to authorized tailnet clients. Use the
fully qualified `ts.net` URL for TLS validation; the certificate is provisioned for the MagicDNS name.

## Post-sync verification

After Argo reconciles this app from `main`, verify the core application and generated Tailscale resources:

```sh
kubectl get application -n argocd restate -o wide
kubectl get ingress -n restate restate-admin-tailscale -o wide
kubectl get pods -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale -o wide
```

Expected:

- the `restate` Argo Application is `Synced` and `Healthy`;
- `restate-admin-tailscale` reports `restate.ide-newton.ts.net` on TCP `443`;
- one Tailscale proxy pod exists in the `tailscale` namespace with parent type `ingress` and parent name
  `restate-admin-tailscale`;
- opening `https://restate.ide-newton.ts.net/` from an authorized tailnet client reaches the Restate admin UI with a
  valid TLS certificate;
- TCP port `80` is not required for the tailnet endpoint.

Verify the NetworkPolicy still blocks ordinary cluster workloads from admin port `9070`:

```sh
kubectl run restate-admin-deny-check \
  -n default \
  --rm \
  -i \
  --restart=Never \
  --image=curlimages/curl:8.17.0 \
  --image-pull-policy=IfNotPresent \
  --command -- sh -ec '
    if curl -sS --connect-timeout 2 --max-time 5 http://restate.restate.svc.cluster.local:9070/services >/tmp/out 2>/tmp/err; then
      echo unexpected_admin_access
      cat /tmp/out
      exit 1
    fi
    echo admin_access_blocked
    cat /tmp/err
  '
```

Expected result: `admin_access_blocked`.

## Recovery

If `https://restate.ide-newton.ts.net/` is unreachable after Argo sync:

1. Inspect the Ingress and Tailscale proxy pod:
   ```sh
   kubectl describe ingress -n restate restate-admin-tailscale
   kubectl get pods -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale -o wide
   kubectl logs -n tailscale -l tailscale.com/parent-resource-ns=restate,tailscale.com/parent-resource=restate-admin-tailscale --tail=200
   ```
2. Verify Restate itself is healthy inside the cluster:
   ```sh
   kubectl -n restate port-forward svc/restate 9070:9070
   curl -sSf http://127.0.0.1:9070/services
   ```
3. Confirm the NetworkPolicy has the Tailscale parent-resource allow rule with type `ingress` for
   `restate-admin-tailscale`.
4. If the HTTPS endpoint does not converge, revert this Ingress layer through a normal PR and investigate the
   Tailscale operator before restoring any layer-3 exposure.

Do not expose Restate admin port `9070` through a public Ingress or unrestricted LoadBalancer. The admin port allows state-changing deployment registration.

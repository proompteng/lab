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

Restate 1.7.2 remains pinned for the resilience migration. The existing `restate-0` node and its retained RBD PVC are
the cluster seed; this application must never auto-provision another cluster. `RESTATE_AUTO_PROVISION=false` and the
three stable StatefulSet node addresses are therefore configured before replicas are increased.

The migration intentionally enables partition snapshots before adding worker nodes. Restate's HA guidance requires a
snapshot repository when growing a cluster because a new partition processor may need a snapshot if its log was
trimmed before the node joined. `restate-snapshots` is a Rook `ObjectBucketClaim`; generated RGW credentials are read
only from the OBC Secret and never stored in Git. Snapshots are written below
`s3://restate-snapshots/partitions`, scheduled every 30 minutes, and retain the newest two snapshots per partition.
RGW is only a partition-snapshot repository: Restate's replicated metadata/Raft state and replicated logs remain on
the per-node RBD volumes.

The singleton layer includes a fail-closed PreSync rollback guard. If a later HA layer is reverted after replication
was raised, it performs Restate's documented shrink sequence while all three pods still exist and only permits the
StatefulSet downscale after replication is one, removable workers/log servers are drained, metadata is singleton, a
snapshot has trimmed historic nodesets, and all 24 partitions/logs reference only `restate-0`.
This HA layer omits that guard during normal operation; reverting this layer reintroduces the parent PreSync guard
before Argo can apply the singleton StatefulSet.

The `restate-snapshot-bootstrap` PostSync hook forces the first partition snapshot after the singleton restarts with
the repository configured. It succeeds only when all 24 partition processors report an archived LSN. Do not increase
replicas until that hook has succeeded and the snapshot objects are present in RGW.

The next stack layer expands the unchanged StatefulSet pod template from one replica to three. Because the snapshot
foundation is merged first, `restate-0` is not restarted by this scale change; `restate-1` and `restate-2` join the
existing cluster with empty retained RBD PVCs and bootstrap worker state from the snapshot repository as needed. A PDB
with `minAvailable: 3` blocks voluntary disruption during the replication migration; it must not be relaxed until
replication two and healthy three-node quorum are proven live.

`restate-replication-migration` is a PostSync hook and is the only component allowed to change the already-provisioned
cluster replication setting. It first requires all three stable node names to be alive and ready, all three metadata
servers to report the same three-member Raft configuration, and partition snapshots to remain archived. It then uses
the Restate 1.7.2-supported `restatectl config set --replication 2 --yes` operation. It refuses mixed or unexpected
replication state and succeeds only after all 24 log tails report replication two and all 24 partitions have exactly
two active processors. On roll-forward after singleton rollback it reactivates only the exact retained
`restate-1`/`restate-2` node IDs (log storage read-write, worker active, metadata member) before readiness and rejects
unexpected identities. This is intentionally different from setting `default-replication`: Restate documents that the
default is only used when a cluster is initially provisioned and does not migrate existing logs or partitions.

The placement contract is deliberately host-based. The current Kubernetes nodes do not carry zone labels, so the
StatefulSet uses required pod anti-affinity and a `DoNotSchedule` topology spread on `kubernetes.io/hostname`; a zone
spread would claim a failure domain the cluster does not actually advertise. Restate gets 60 seconds for graceful
shutdown inside a 90-second Kubernetes termination window.

Useful read-only checks for the snapshot foundation are:

```sh
kubectl get objectbucketclaim -n restate restate-snapshots
kubectl get job -n restate restate-snapshot-bootstrap
kubectl exec -n restate restate-0 -- restatectl --address http://127.0.0.1:5122 config get
kubectl exec -n restate restate-0 -- restatectl --address http://127.0.0.1:5122 partitions list
```

The official contracts used by this migration are Restate's
[HA cluster guide](https://docs.restate.dev/server/deploy/ha),
[metadata storage guide](https://docs.restate.dev/server/deploy/metadata), and
[snapshots and backups guide](https://docs.restate.dev/server/deploy/snapshots).

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

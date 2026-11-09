# Restate

Restate 1.8.1 uses three retained members on three physical hosts. Each member keeps its native node identity,
metadata, logs and worker state on the existing generic `local-path` class backed by local NVMe. The three claims
request 16Gi each. Local-path requests do not reserve space or impose quotas; monitor actual host free space.

| Member | Host | Roles |
| --- | --- | --- |
| restate-0 | turin | metadata, log, worker, admin, ingress |
| restate-1 | talos-192-168-1-194 | metadata, log, admin, ingress |
| restate-2 | talos-192-168-1-85 | metadata, log, worker, admin, ingress |

Required host anti-affinity and each bound local PV's node affinity keep the members on separate hosts. Workers use
Turin and Altra's 100G network; Ryzen participates in metadata and log durability over its slower link. Metadata has
three voters. Native cluster configuration replicates logs and partitions twice across 24 partitions, with 48 active
partition processors when both workers are healthy. `default-replication=2` agrees with the existing provisioned
configuration; defaults do not migrate an existing cluster. Automatic provisioning remains disabled.

All WAL synchronization and write-completion requirements remain enabled. RGW stores periodic partition snapshots,
not the running metadata or WAL. The protected `restate-snapshots` ObjectBucketClaim retains its bucket independently
of the application. Keep the existing request-signing key and registered service/deployment identities.

## Delivery and recovery checks

The `Restate images` workflow validates the application and release contracts. Unchanged Docker context and build
parameters reuse the signed Kargo-selected runtime with identical filesystem layers. A Dockerfile, patch, runtime test,
or build-parameter change runs both native builds and their fault proofs. Main source builds persist all four Cargo
cache mounts as signed architecture-specific images in the existing registry; pull requests only read those caches.

Each release validates platform source labels, signs the multi-platform index, uploads its receipt, and only then
exposes the immutable run-qualified Kargo alias. The Warehouse and Stage `lab-delivery/restate` own promotion to
`kargo/restate`. Argo follows that exact generated revision under the
[release contract](../../../docs/release-automation.md). Configuration releases also use this path.

`RollingUpdate` replaces one member at a time. Its read-only startup probe requires the current native generation,
alive membership, current partition assignments and active replay, then advancing status timestamps across two
observations. A metadata/log-only member must have no worker assignments. Empty, draining, disabled, provisioning,
stale or partially recovered workers remain unready. The probe does not write configuration or reactivate workers.
The existing HTTP readiness check follows startup recovery. Retained workers recover through Restate's native logs
and snapshot integration; there are no singleton bootstrap, replication-migration or contraction hooks.

Before a replacement, require three healthy members, identical three-voter metadata membership, replication two,
positive archived snapshot LSNs for all 24 partitions and a successful same-version offline snapshot restore. The
`minAvailable: 3` PDB blocks voluntary evictions. Preserve it during this rollout; changing it is a separate decision.
After replacement, verify the original node ID in its new generation, full partition recovery, real durable application
work, Bayn progress and the corresponding traces. Ready Pods and a healthy Application alone do not prove this.

Fence an old writer before recovering a lost disk or host. Preserve surviving native logs, metadata and snapshots.
Follow the upstream [HA](https://docs.restate.dev/server/deploy/ha) and
[rolling-update](https://docs.restate.dev/server/upgrading#rolling-updates) procedures. Fix forward on the current
three-member NVMe implementation. Do not reprovision empty state, lower replication, disable fsync, restore the removed
singleton path or overwrite newer acknowledged work with an older offline copy.

## Runtime and failure detection

The [runtime build](../../../services/restate/README.md) pins upstream Restate 1.8.1 and retains two regression-tested
patches. Metadata writes use the existing background I/O executor while still awaiting durable completion. Bounded
cold-peer election requests can reach a newly connected peer. Log-server and partition writes use their native
`always-commit-in-background` options.

| Setting | Value |
| --- | --- |
| Metadata election | 450 ticks at 100ms; randomized election attempts take 45–90s |
| Gossip failure | 450 ticks at 100ms |
| Gossip loneliness | 600 ticks at 100ms |
| Gossip message age | 5s |
| Peer connect, handshake and HTTP/2 keep-alive timeout | 10s each |
| Metadata-client connect and keep-alive timeout | 10s each |

Metadata heartbeats remain two ticks apart. Leader replacement can exceed Bayn's 30s pass deadline; Bayn retains its
normal restriction, settlement and recovery behavior. These settings are not an availability or latency guarantee.

## Snapshots and telemetry

Native workers create snapshots every 30 minutes and retain two. The PostSync restore proof and daily drill use the
promoted runtime's same-version `restate-doctor` to open all 24 latest snapshots in an isolated read-only store and query
invocations. They have no object-store write command. An unsuccessful doctor command cannot supply a success marker.
The proof must succeed before the release completes. A failure requires inspecting its Job/logs and fixing the cause;
keep the protected bucket and production data intact.

All three NodeCtl endpoints are scraped directly. Mimir covers node/quorum health, partition progress, snapshots and
restore-drill freshness. Investigate alerts from time-aligned native logs, metrics and database state. Measure storage
or placement changes under the same offered workload, recording background load, fsync sum/count deltas and request
latency. Software, storage and role changes are separate variables.

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

After Argo reconciles this app from `kargo/restate`, verify the core application and generated Tailscale resources:

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

# Incident Report: Galactic Power Outage, Tailscale Bootstrap Failure, and etcd Quorum Loss

- **Date**: 2026-04-12
- **Detected by**: post-outage cluster health check after a site power event
- **Reported by**: gregkonush
- **Services Affected**: `galactic` Talos control plane, Kubernetes API, `etcd`, node-level Tailscale on `ryzen`, `ampone`, and `altra`, and NUC Tailscale on `192.168.1.130`
- **Severity**: Sev-1
- **Incident Class**: control-plane outage after power restoration
- **Status at report time**: mitigated and recovered; Kubernetes API restored

## Executive Summary

After a power outage, all three Talos control-plane nodes in `galactic` came back far enough to run `apid`,
`machined`, and `kubelet`, but the cluster did not recover. Each node initially remained in Talos `stage: booting`
because `etcd` never became healthy, so the Kubernetes API behind the NUC load balancer never returned.

The immediate control-plane failure was loss of etcd peer connectivity. Each etcd member was still configured to talk
to the other members on `100.x` Tailscale peer addresses over port `2380`, but the nodes did not have working
Tailscale connectivity after the outage. The Talos `ext-tailscale` service on all three control-plane nodes attempted
to run `tailscale up` and failed with `invalid key: API key does not exist`, leaving `tailscale0` without the
expected `100.x` address.

The Intel NUC at `192.168.1.130` was reachable on the LAN and still accepted TCP on `:6443`, but that only confirmed
that the host and HAProxy listener were up. It did not indicate a healthy Kubernetes API. The NUC's own `tailscaled`
service was also unhealthy from a tailnet perspective: it was `active` in systemd but reported `BackendState=NoState`
and `Self.Online=false`, with repeated timeouts trying to register to `controlplane.tailscale.com`. In addition, the
NUC host resolver had drifted into a Tailscale-generated `/etc/resolv.conf` that pointed at `100.100.100.100` while
Tailscale itself was offline, creating a self-referential bootstrap failure for tailnet recovery.

The outage was resolved in two steps:

1. Restore the NUC's own Tailscale bootstrap by returning `/etc/resolv.conf` to `systemd-resolved` management and
   restarting `tailscaled`, which brought `nuc` back online at `100.88.12.116`.
1. Replace the stale Talos node auth key stored at `op://infra/tailscale auth key/authkey`, regenerate the three
   `ExtensionServiceConfig` patches, and patch all control-plane nodes without reboot. That restored `100.x`
   Tailscale addresses on the nodes, etcd quorum, and the Kubernetes API.

This outage exposed a hard control-plane dependency on working Tailscale bootstrap. Once that dependency broke,
etcd could not form quorum and the cluster API remained down even though the hosts themselves were reachable on the
LAN.

## Impact Summary

1. `kubectl` against the `galactic` context timed out against `https://nuc.ide-newton.ts.net:6443`.
1. Direct Talos API access to all three control-plane nodes still worked on their LAN IPs.
1. All control-plane nodes reported `etcd` as `Running` but `Fail`, with health checks ending in
   `context deadline exceeded`.
1. No Kubernetes node objects or workloads could be inspected through the API because kube-apiserver did not have a
   healthy etcd backend.
1. Tailnet-only access paths on both the Talos nodes and the NUC were degraded or unavailable.

## User-Facing Symptoms

1. `kubectl cluster-info` and `kubectl get nodes` timed out.
1. The `galactic` kubeconfig target `https://nuc.ide-newton.ts.net:6443` was unreachable over the tailnet path.
1. TCP to `192.168.1.130:6443` was open, but the API never returned a healthy response.
1. Talos machine status on all control-plane nodes showed:
   - `stage: booting`
   - `ready: false`
   - unmet condition `services: etcd not healthy`
1. etcd logs on all three nodes showed repeated raft election loops and peer dial timeouts to `100.x` addresses.

## Root Cause

The immediate root cause of the Kubernetes control-plane outage was loss of etcd peer connectivity across all three
Talos control-plane nodes.

Primary causes:

1. **etcd peer URLs were bound to Tailscale `100.x` addresses**
   - etcd on `192.168.1.85`, `192.168.1.194`, and `192.168.1.203` attempted to dial peer addresses on `100.x.x.x:2380`.
   - Those addresses were unreachable after reboot because node-level Tailscale did not come up.

2. **Talos node Tailscale bootstrap failed on all control-plane nodes**
   - `ext-tailscale` restarted repeatedly.
   - Logs showed `tailscale up` failing with `invalid key: API key does not exist`.
   - `tailscale0` existed only with link-local IPv6 and no `100.x` IPv4 address.

3. **The cluster had no fallback etcd peer transport on the LAN**
   - Even though the hosts were reachable on `192.168.1.x`, etcd was not using those addresses for peer traffic.
   - Losing Tailscale peer transport therefore meant losing quorum.

## Contributing Factors

1. **NUC Tailscale was also down**
   - On `192.168.1.130`, `tailscaled` was `active` but not online.
   - `tailscale status --json` reported `BackendState=NoState` and `Self.Online=false`.
   - Logs showed repeated registration timeouts to `https://controlplane.tailscale.com/machine/register`.

2. **Talos nodes depend on both Tailscale DNS and the NUC for DNS**
   - The Talos DNS patch and live resolver state on all three nodes contained:
     - `100.100.100.100`
     - `192.168.1.130`
   - The NUC was confirmed to be listening on port `53` with `pihole-FTL`.

3. **LAN host reachability obscured control-plane failure**
   - The NUC host was reachable on `192.168.1.130`, and TCP `:6443` was open.
   - That could be misread as “the API endpoint is healthy,” but it only proved the load balancer socket existed.

4. **This outage combined two different Tailscale failure modes**
   - Talos nodes: invalid auth key during `tailscale up`
   - NUC: inability to register to the Tailscale control plane due to network timeout

5. **The Talos control-plane endpoint relied on hostname resolution**
   - Live Talos machine configs pointed `cluster.controlPlane.endpoint` at `https://nuc.ide-newton.ts.net:6443`.
   - The NUC API load balancer runbook treats `https://192.168.1.130:6443` as the compatibility default and only
     treats hostname-based endpoints as optional when name resolution is healthy.

## What Was Not the Root Cause

1. The NUC host itself was not powered off or unreachable on the LAN.
1. The Talos node operating systems were not completely down; `apid`, `machined`, and `kubelet` were running.
1. This was not initially a kubelet scheduling issue or a single broken workload. The failure happened before the
   Kubernetes control plane became available.
1. This was not purely a DNS-name lookup failure for etcd peers. etcd was dialing numeric `100.x` peer IPs directly,
   and those connections timed out.

## Approximate Timeline

| Time | Event |
| --- | --- |
| 2026-04-12 21:08Z | `tailscaled` on the NUC started running again after the outage, but remained in `NoState`. |
| 2026-04-12 21:09Z onward | NUC logs showed repeated registration failures to `controlplane.tailscale.com` with `context deadline exceeded`. |
| 2026-04-12 21:25Z-21:28Z | Talos control-plane nodes `192.168.1.194`, `192.168.1.203`, and `192.168.1.85` booted and exposed Talos API again. |
| 2026-04-12 21:26Z onward | Talos machine status on each node remained `booting`, with unmet condition `etcd not healthy`. |
| 2026-04-12 21:35Z onward | etcd logs showed repeated pre-vote loops and timeouts dialing peers on `100.126.71.62:2380`, `100.73.189.86:2380`, and `100.108.8.111:2380`. |
| 2026-04-12 21:35Z onward | `ext-tailscale` on Talos nodes failed `tailscale up` with `invalid key: API key does not exist`. |
| 2026-04-12 21:36Z | Verification showed NUC SSH reachable, LAN TCP `:6443` open, but tailnet path to the NUC unavailable and cluster API still down. |
| 2026-04-12 ~21:47Z | NUC host resolver was restored to `systemd-resolved` management, `tailscaled` restarted, and NUC Tailscale recovered to `100.88.12.116`. |
| 2026-04-12 ~22:00Z | Tailscale admin confirmed there were no active auth keys, proving the Talos node auth key stored in 1Password was stale. |
| 2026-04-12 ~22:03Z | A new reusable tagged auth key (`tag:k8s-subnet-router`) was generated, stored back into 1Password, and used to regenerate Talos node `tailscale-extension-service.yaml` files. |
| 2026-04-12 ~22:04Z | Regenerated `ExtensionServiceConfig` patches were applied to `192.168.1.85`, `192.168.1.194`, and `192.168.1.203` with `talosctl patch machineconfig --mode no-reboot`. |
| 2026-04-12 ~22:05Z | Talos nodes regained `100.x` Tailscale IPs, `etcd` quorum returned, and `kubectl get nodes` showed all three control-plane nodes `Ready`. |

## Evidence Collected

### Talos machine status

All three nodes reported the same pattern:

1. `stage: booting`
1. `ready: false`
1. `services: etcd not healthy`
1. `nodeReady: node status is not available yet`

### Talos services

On each control-plane node:

1. `apid`: `Running / OK`
1. `kubelet`: `Running / OK`
1. `machined`: `Running / OK`
1. `etcd`: `Running / Fail`

### etcd logs

Representative errors from the nodes:

1. `failed to publish local member to cluster through raft ... context deadline exceeded`
1. `prober detected unhealthy status ... dial tcp 100.126.71.62:2380: i/o timeout`
1. `prober detected unhealthy status ... dial tcp 100.73.189.86:2380: i/o timeout`
1. `prober detected unhealthy status ... dial tcp 100.108.8.111:2380: i/o timeout`

### Talos Tailscale logs

Representative errors from `ext-tailscale`:

1. `Received error: invalid key: API key does not exist`
1. `failed to auth tailscale: tailscale up failed: exit status 1`
1. No node had a usable `100.x` address on `tailscale0`.
1. After the new auth key was deployed, all three nodes successfully acquired:
   - `192.168.1.85` -> `100.108.8.111`
   - `192.168.1.194` -> `100.126.71.62`
   - `192.168.1.203` -> `100.73.189.86`

### NUC Tailscale status and logs

Observed on `192.168.1.130`:

1. `systemctl is-active tailscaled` returned `active`
1. `tailscale status --json` returned:
   - `BackendState=NoState`
   - `Self.Online=false`
1. `journalctl -u tailscaled` showed repeated:
   - `register request: Post "https://controlplane.tailscale.com/machine/register": connection attempts aborted by context: context deadline exceeded`
1. A DNS-related warning also appeared:
   - `lookup log.tailscale.com on 100.100.100.100:53: ... i/o timeout`
1. The NUC was confirmed to be listening on `:53` via `pihole-FTL`.
1. After restoring `/etc/resolv.conf` to `/run/systemd/resolve/resolv.conf` and restarting `systemd-resolved` and
   `tailscaled`, the NUC returned to:
   - `Self.Online=true`
   - `Tailscale IP 100.88.12.116`
   - `CorpDNS=false`
   - `RouteAll=true`

## Key Observation About DNS Dependency

There is a real DNS dependency on the NUC from the Talos nodes.

Verified live resolver configuration on the Talos nodes:

1. `100.100.100.100`
1. `192.168.1.130`

This means NUC DNS availability matters for normal name resolution. However, the current etcd outage was not blocked on
resolving peer hostnames at the moment of failure. etcd was already attempting direct connections to numeric Tailscale
peer addresses and timing out there. DNS dependency is therefore a contributing factor in the wider outage context, but
not sufficient by itself to explain the loss of etcd quorum.

## Resolution

The outage was mitigated with these concrete steps:

1. **Recover NUC Tailscale bootstrap**
   - Restored `/etc/resolv.conf` on `192.168.1.130` to the `systemd-resolved` managed file.
   - Restarted `systemd-resolved` and `tailscaled`.
   - Verified the NUC returned online at `100.88.12.116`.

2. **Sync the NUC to repo-backed DNS config**
   - Re-applied the repo versions of:
     - `devices/nuc/pihole/pihole.toml`
     - `devices/nuc/pihole/99-kubernetes-split-dns.conf`
   - Reasserted `tailscale --accept-routes=true`.
   - Restarted `pihole-FTL`.

3. **Replace the stale Talos auth key**
   - Verified the Tailscale admin UI had no active auth keys.
   - Generated a new reusable tagged auth key with `tag:k8s-subnet-router`.
   - Updated the 1Password secret at `op://infra/tailscale auth key/authkey`.

4. **Regenerate and re-apply Talos node Tailscale config**
   - Re-rendered:
     - `devices/ryzen/manifests/tailscale-extension-service.yaml`
     - `devices/ampone/manifests/tailscale-extension-service.yaml`
     - `devices/altra/manifests/tailscale-extension-service.yaml`
   - Verified the generated patches contained the new auth key and `TS_ACCEPT_DNS=false`.
   - Applied all three patches with `talosctl patch machineconfig --mode no-reboot`.

5. **Verify cluster recovery**
   - Confirmed all three Talos nodes regained `100.x` Tailscale addresses.
   - Confirmed etcd quorum and leadership returned.
   - Confirmed `kubectl get nodes` reported all three control-plane nodes `Ready`.

## Final Verified State

Verified after recovery:

1. NUC Tailscale:
   - `Online=true`
   - `Tailscale IP=100.88.12.116`
   - `RouteAll=true`
   - `CorpDNS=false`

2. Talos nodes:
   - `192.168.1.85` machine status: `stage: running`, `ready: true`
   - `192.168.1.194` machine status: `stage: running`, `ready: true`
   - `192.168.1.203` machine status: `stage: running`, `ready: true`

3. Kubernetes:
   - `kubectl get nodes -o wide` returned:
     - `talos-192-168-1-85 Ready`
     - `talos-192-168-1-194 Ready`
     - `talos-192-168-1-203 Ready`
   - Static control-plane pods were running again in `kube-system`

## Workload Recovery After Control-Plane Restore

Once the control plane was back, several stateful workloads were still unhealthy because they had been left behind in
stale post-outage pod and CSI mount states. The surviving persistent volumes were intact, so these were recovered by
replacing the broken pods and allowing the controllers to re-attach storage and complete their own startup sequences.

### Registry namespace

Observed after the API returned:

1. `deployment/registry` was `0/1`
1. `service/registry` had no endpoints
1. The only registry pod was stuck with container state `Terminated`, `Reason=Unknown`, `Exit Code=255`
1. `registry-data` PVC remained `Bound`
1. Recent events showed CSI attach and mount failures left over from the outage:
   - `rook-ceph.rbd.csi.ceph.com not found in the list of registered CSI drivers`
   - `DeadlineExceeded`
   - `operation with the given Volume ID ... already exists`

Recovery steps:

1. Verified the backing Ceph image still existed and `ceph -s` was healthy.
1. Deleted the stale registry pod.
1. Allowed the deployment to recreate it and waited for rollout.
1. Verified the new pod mounted the PVC and started normally.

Final verification:

1. `pod/registry-845ddfc8ff-tbjlj` reached `1/1 Running`
1. `service/registry` regained endpoint `10.244.5.148:5000`
1. In-cluster HTTP check to `http://registry/v2/` returned `{}`, which is the expected unauthenticated Docker
   Registry API response

### Jangar database

Observed after control-plane restore:

1. `jangar-db-1` existed but the prior container state was `Terminated`, `Reason=Unknown`, `Exit Code=255`
1. `jangar-db-rw` and `jangar-db-r` had empty endpoints
1. `jangar-db-1` PVC remained `Bound`
1. The Ceph RBD volume still existed
1. CSI logs indicated stuck attach state rather than missing storage

Recovery steps:

1. Deleted pod `jangar-db-1` and allowed CNPG to recreate it.
1. Waited for PostgreSQL WAL replay and consistent recovery to complete.
1. Confirmed CNPG changed from `Waiting for the instances to become active` back to healthy.

During restart, PostgreSQL briefly reported expected recovery-phase errors:

1. `FATAL: the database system is not yet accepting connections`
1. `detail: Consistent recovery state has not been yet reached`

The decisive completion signal was:

1. `database system is ready to accept connections`

Final verification:

1. `pod/jangar-db-1` reached `1/1 Running`
1. `cluster.postgresql.cnpg.io/jangar-db` returned `Ready=True`
1. `jangar-db-r` and `jangar-db-rw` regained endpoint `10.244.2.238:5432`
1. `pg_isready` inside the postgres container returned `accepting connections`

### Open WebUI

Observed after `jangar-db` recovered:

1. `open-webui-0` was still in `CrashLoopBackOff`
1. The pod had already cleared the earlier CSI mount problem and was now repeatedly restarting the application
   container
1. The container environment pointed at `jangar-db-app`, so the most likely explanation was that the earlier database
   outage left the app in a bad startup loop

Recovery steps:

1. Deleted pod `open-webui-0` and allowed the StatefulSet to recreate it.
1. Waited for the replacement pod to complete initialization and become ready.

Final verification:

1. Replacement `open-webui-0` reached `1/1 Running`
1. Startup logs showed:
   - `Connected to PostgreSQL database`
   - `There is nothing to migrate`
1. The pod stopped crash-looping and resumed normal startup

### Temporal Cassandra ordinal `0`

Observed after the cluster and most stateful workloads were back:

1. `temporal-cassandra-0` remained `0/1` and appeared as `Unknown` in both Kubernetes and Argo CD.
1. `StatefulSet/temporal-cassandra` was only `2/3 Ready`.
1. kubelet was repeatedly failing the Cassandra volume mount with:
   - `internal RBD image not found`
   - `Failed as image not found (internal RBD image not found: rbd: ret=-2, No such file or directory)`
1. The PVC and PV still existed, but the backing Ceph RBD metadata object was gone:
   - `rbd_id.csi-vol-9f1196b1-44da-47ba-a909-dd898c45c501` did not exist in `replicapool`
1. Cassandra ring status from the surviving nodes showed:
   - `temporal-cassandra-1` and `temporal-cassandra-2` were `UN`
   - the dead host ID was `8c255ef8-7bbc-4752-8d4e-4d3a1366f52c`
1. The `temporal` Cassandra keyspace was configured with:
   - `SimpleStrategy`
   - `replication_factor = 1`

That combination meant the missing `temporal-cassandra-0` volume was not restorable from the live cluster and there was
no visible in-cluster backup or snapshot path for that PVC. Recovery therefore required a destructive single-node
rebuild, with an explicit data-loss caveat for any data that existed only on the lost ordinal `0` volume.

Recovery steps:

1. Removed the dead Cassandra ring member:
   - `nodetool removenode 8c255ef8-7bbc-4752-8d4e-4d3a1366f52c`
1. Force-deleted pod `temporal-cassandra-0`.
1. Deleted PVC `data-temporal-cassandra-0`.
1. Allowed `StatefulSet/temporal-cassandra` to provision a fresh replacement PVC and recreate only ordinal `0`.
1. Waited for the replacement node to rejoin the ring with a new host ID:
   - `49cbb919-5b4c-4489-bab3-ec01a67297fa`
1. Forced a fresh Argo sync for the `temporal` application so the `temporal-schema-1` hook job re-ran and cleared the
   app’s stale `Missing` state.

Final verification:

1. `kubectl exec -n temporal temporal-cassandra-1 -- nodetool status` showed all three Cassandra nodes `UN`
1. `StatefulSet/temporal-cassandra` returned `3/3 Ready`
1. `temporal-cassandra-0`, `temporal-cassandra-1`, and `temporal-cassandra-2` were all `1/1 Running`
1. `temporal-schema-1` completed successfully
1. `kubectl get application -n argocd temporal` returned `Synced / Healthy`
1. All Temporal deployments (`frontend`, `history`, `matching`, `worker`, `web`) were `1/1 Running`

### Observability namespace and RGW credential ownership

Observed after control-plane restore:

1. `observability` workloads were split between healthy and crash-looping states.
1. Tempo and Mimir logs reported S3 initialization failures against the original buckets:
   - `Endpoint url cannot have fully qualified paths.`
   - earlier `Access Denied` failures against `tempo-traces`, `mimir-blocks`, `mimir-alertmanager`, and `mimir-ruler`
1. The live `observability/rook-ceph-rgw-loki` secret had become a mixed transitional object:
   - it contained both reflected Rook keys and legacy compatibility keys
   - it still had an `ownerReference` to the old `SealedSecret`
   - source-side Rook resources were still tracked under the `observability` app instead of `rook-ceph`

An initial recovery detour created temporary `*-recovery-20260412` buckets to get services back quickly. That was a
mistake for observability because it breaks log, metric, and trace continuity. The temporary buckets were removed and
the active path was returned to the original buckets before finalizing the GitOps repair.

Recovery steps:

1. Repaired original RGW bucket access for user `loki` in zone `objectstore` by fixing bucket ownership and linking
   for:
   - `loki-data`
   - `tempo-traces`
   - `mimir-blocks`
   - `mimir-alertmanager`
   - `mimir-ruler`
1. Reverted live Loki, Mimir, and Tempo config back to the original buckets.
1. Deleted the mistaken `*-recovery-20260412` buckets after confirming observability was no longer pointed at them.
1. Merged GitOps PR [#5027](https://github.com/proompteng/lab/pull/5027),
   `fix(observability): switch rgw credentials to reflector`, which:
   - removed the hand-sealed observability secret path
   - introduced a reflector target secret in `observability`
   - switched the consumers to the reflected uppercase credential keys
1. Merged GitOps PR [#5028](https://github.com/proompteng/lab/pull/5028),
   `fix(observability): pin rgw endpoint and move source ownership`, which:
   - stopped sourcing the RGW endpoint from the reflected secret
   - pinned the endpoint explicitly in values
   - moved source-side ownership to the `rook-ceph` app
1. Cleared stale live ownership metadata that was blocking Argo convergence:
   - removed the old `SealedSecret` owner reference from `observability/rook-ceph-rgw-loki`
   - deleted the live `SealedSecret/rook-ceph-rgw-loki`
   - removed stale `observability` tracking annotations from the source secret and `CephObjectStoreUser/loki`
1. Refreshed Argo applications and replaced stale stateful pods created under the bad intermediate revision so they
   restarted on the merged spec.

Correct final ownership model:

1. `rook-ceph` app owns:
   - `CephObjectStoreUser/loki`
   - source secret `rook-ceph-object-user-objectstore-loki`
   - reflector-allow annotations on the source secret
1. `observability` app owns:
   - reflected target secret `observability/rook-ceph-rgw-loki`
   - Loki, Mimir, and Tempo consumers

Final verification:

1. `kubectl get application -n argocd observability` returned `Synced / Healthy`
1. `kubectl get application -n argocd rook-ceph` returned `Synced / Healthy`
1. Both apps converged on revision `ceb95e795cfc3b2926aea0b08932c2a7d9e2edc5`
1. `observability/rook-ceph-rgw-loki`:
   - had no `ownerReferences`
   - tracked under `observability`
   - reflected `rook-ceph/rook-ceph-object-user-objectstore-loki`
   - contained only `AccessKey`, `SecretKey`, and `Endpoint`
1. `rook-ceph/rook-ceph-object-user-objectstore-loki` and `CephObjectStoreUser/loki` tracked under `rook-ceph`

### Tailscale operator crash loop after recovery

Observed after the cluster and most workloads were back:

1. `Application/tailscale` in Argo CD still showed healthy-looking app state, but the actual operator pod was
   crash-looping:
   - `pod/tailscale/operator-86dcfd9bc7-t92g2` -> `0/1 CrashLoopBackOff`
1. Operator logs showed repeated missing-CRD failures:
   - `no matches for kind "Tailnet" in version "tailscale.com/v1alpha1"`
   - `no matches for kind "ProxyGroupPolicy" in version "tailscale.com/v1alpha1"`
   - `could not start manager: failed to wait for tailnet-reconciler caches to sync`
1. The live GitOps app was version-skewed:
   - `argocd/applications/tailscale/kustomization.yaml` rendered a raw
     `https://raw.githubusercontent.com/tailscale/tailscale/refs/tags/v1.94.2/.../operator.yaml`
   - then overrode the operator and proxy images to `tailscale/k8s-operator:stable` and `tailscale/tailscale:stable`
1. The installed CRDs matched the older raw manifest set and were missing:
   - `tailnets.tailscale.com`
   - `proxygrouppolicies.tailscale.com`

This was a pure GitOps manifest/image skew problem: the stable operator binary expected newer CRDs than the pinned
`v1.94.2` raw manifest installed.

Recovery steps:

1. Replaced the raw manifest + image override approach with the official stable Helm chart:
   - `tailscale/tailscale-operator` `1.96.5`
   - app path: `argocd/applications/tailscale`
   - old broken path: raw `v1.94.2` `operator.yaml` plus floating `tailscale/*:stable` image overrides
   - new path: chart-managed operator, image version, and CRD set from one release
1. Enabled chart-managed CRD installation:
   - `installCRDs: true`
1. Mounted the existing sealed OAuth secret directly via chart values:
   - `oauthSecretVolume.secret.secretName: operator-oauth-token`
1. Removed the dead raw-manifest patching path that had been:
   - rewriting the operator deployment image
   - rewriting `PROXY_IMAGE`
   - rewriting the mounted secret name
1. Merged GitOps PR [#5029](https://github.com/proompteng/lab/pull/5029),
   `fix(tailscale): install stable operator chart with crds`
1. Forced an Argo hard refresh on `Application/tailscale` so it reconciled the merged revision immediately instead of
   waiting for the next poll.

Final verification:

1. `kubectl get application -n argocd tailscale` returned `Synced / Healthy`
1. `kubectl get pod -n tailscale -l app=operator` returned:
   - `operator-65b587d85-6ttdc 1/1 Running 0 restarts`
1. Both previously missing CRDs existed:
   - `tailnets.tailscale.com`
   - `proxygrouppolicies.tailscale.com`
1. No pods in `namespace/tailscale` remained outside `Running` or `Completed`
1. Current synced revision was:
   - `cf75512025caf7b618fb05f51438254969b1942b`

### Feature-flags recovery and GitOps follow-up

Observed after the control plane was back:

1. `Application/feature-flags` could report `Synced` while the only Flipt pod was broken.
1. The first failure mode was a missing required config object:
   - `MountVolume.SetUp failed for volume "flipt-config" : configmap "feature-flags" not found`
1. After recreating the configmap, Flipt itself still crash-looped with:
   - `initializing environment store: environment "default": performing initial fetch: ref file is empty`
1. The backing PVC `feature-flags` was intact, but the bare Git cache at
   `/var/opt/flipt/repositories/default` had corrupted remote-tracking state.

Root causes:

1. The Flipt chart rendered `ConfigMap/feature-flags` as a Helm hook:
   - `helm.sh/hook: pre-install,pre-upgrade`
   - `helm.sh/hook-weight: "-1"`
1. Because the configmap was hook-managed instead of a normal steady-state object, Argo CD did not treat its absence as
   ordinary drift and could still show the app as effectively healthy while the workload could not mount.
1. The bare repo cached on the PVC had a broken remote-tracking ref under:
   - `refs/remotes/origin/feature-flags-state`
   which caused Flipt's initial fetch path to fail after the outage.

Recovery steps:

1. Recreated `ConfigMap/feature-flags` from the current chart render and repo values so the pod could mount
   `/etc/flipt/config/default.yml`.
1. Inspected the PVC through a temporary debug pod and confirmed the cached repo corruption under
   `/var/opt/flipt/repositories/default`.
1. Repaired the bare repo state and restored it as the active cache, then restarted `Deployment/feature-flags`.
1. Verified the application returned to:
   - `pod/feature-flags-7749dddcfd-gmk5j 1/1 Running`
   - live endpoints on `10.244.2.192:8080,443,9000`
1. Merged GitOps PR [#5030](https://github.com/proompteng/lab/pull/5030),
   `fix(feature-flags): manage flipt configmap in argocd`, which:
   - patched the rendered `ConfigMap/feature-flags`
   - removed `helm.sh/hook`
   - removed `helm.sh/hook-weight`
   - allowed Argo CD to manage the configmap as a normal steady-state resource
1. Deleted the stale hook-created live configmap and forced an Argo refresh so Argo recreated it from the merged
   desired state.

Intentional tailnet exposure:

1. `Service/feature-flags-tailscale` is not accidental drift.
1. It is defined in GitOps at:
   - `argocd/applications/feature-flags/tailscale-service.yaml`
1. It intentionally exposes Flipt on the tailnet via:
   - hostname `feature-flags.ide-newton.ts.net`
   - Tailscale IP `100.74.76.18`
1. It forwards to the same Flipt pod on port `8080` via a normal Kubernetes endpoint object.

Final verification:

1. `kubectl get application -n argocd feature-flags` returned `Synced / Healthy`
1. `ConfigMap/feature-flags` was present and tracked by Argo as a normal resource:
   - `argocd.argoproj.io/tracking-id: feature-flags:/ConfigMap:feature-flags/feature-flags`
1. The live configmap no longer carried:
   - `helm.sh/hook`
   - `helm.sh/hook-weight`
1. `Service/feature-flags-tailscale` remained healthy and pointed at the running Flipt pod
1. Current synced revision was:
   - `65cefb659df0bd97002cac350429330b36023048`

## Recovery Sequence Summary

The practical recovery order for this outage was:

1. Recover NUC Tailscale and resolver bootstrap.
1. Replace the stale Talos node Tailscale auth key and re-apply node `ExtensionServiceConfig` patches.
1. Wait for etcd quorum and Kubernetes API recovery.
1. Replace any workload pods left in stale post-outage CSI or crash-loop states.
1. For Temporal Cassandra, treat a missing Ceph RBD image as a storage-loss event, not a restart problem. Confirm ring
   health and keyspace replication before choosing a destructive rebuild.
1. For observability, restore the original RGW bucket path first, then fix secret ownership and endpoint handling
   through GitOps instead of carrying live hotfix drift forward.
1. For Tailscale operator, do not mix a pinned raw manifest bundle with floating `stable` images. Use one coherent
   delivery mechanism that owns both the operator version and its CRD set.
1. For feature-flags, treat the Flipt Git cache on the PVC as a stateful dependency and ensure the required
   `ConfigMap/feature-flags` is a normal Argo-managed resource instead of a hook-only artifact.
1. Verify service endpoints and application-level readiness, not just `Running` pod phase.

## Longer-Term Corrective Actions

1. Remove the hard dependency on Tailscale peer transport for etcd quorum, or at minimum document and test a LAN-only
   recovery path.
1. Rotate Talos node Tailscale auth material before planned expiry or invalidation.
1. Stop relying on `https://nuc.ide-newton.ts.net:6443` as the Talos control-plane endpoint during recovery. Update
   machine configs to the NUC runbook default `https://192.168.1.130:6443` unless there is a strong reason to keep the
   hostname.
1. Add a post-reboot validation checklist for:
   - node-level Tailscale online state
   - NUC Tailscale online state
   - etcd member reachability
   - kube-apiserver health on the NUC load balancer
   - RBD CSI nodeplugin health on each Talos node
   - readiness of stateful workloads with Ceph-backed PVCs
   - Cassandra keyspace replication settings before rebuilding any lost Temporal PVC
   - observability RGW secret ownership under the correct Argo apps
1. Consider a documented break-glass kubeconfig that targets the LAN endpoint directly when the tailnet path is down.
1. Do not source shared object-store endpoints from reflected secrets unless every consumer expects the same value
   format. In this case, Rook's `Endpoint` value included `http://...`, while Tempo and Mimir expected plain
   `host:port`.
1. Do not pair floating `tailscale/*:stable` images with a separately pinned raw operator manifest. Either pin the
   full manifest/image set to one release or use the official Helm chart with chart-managed CRDs.
1. Do not leave required application config behind Helm hook annotations when the workload expects it to exist
   continuously. In this case, `ConfigMap/feature-flags` had to be converted into a normal Argo-managed resource.

## Commands Used During Investigation

```bash
kubectl --request-timeout=10s cluster-info
kubectl --request-timeout=10s get nodes -o wide

talosctl -n 192.168.1.85 -e 192.168.1.85 get machinestatus -o yaml
talosctl -n 192.168.1.194 -e 192.168.1.194 get machinestatus -o yaml
talosctl -n 192.168.1.203 -e 192.168.1.203 get machinestatus -o yaml

talosctl -n <node> -e <node> services
talosctl -n <node> -e <node> logs etcd --tail=120
talosctl -n <node> -e <node> logs ext-tailscale --tail=120
talosctl -n <node> -e <node> get resolvers -o yaml
talosctl -n <node> -e <node> get addresses

ssh kalmyk@192.168.1.130 'systemctl status tailscaled --no-pager --full'
ssh kalmyk@192.168.1.130 'journalctl -u tailscaled -n 200 --no-pager'
ssh kalmyk@192.168.1.130 'tailscale status --json'
ssh kalmyk@192.168.1.130 'ss -luntp | egrep "(:53\\b)|(:41641\\b)"'

kubectl get application -n argocd observability -o yaml
kubectl get application -n argocd rook-ceph -o yaml
kubectl get secret -n observability rook-ceph-rgw-loki -o yaml
kubectl get secret -n rook-ceph rook-ceph-object-user-objectstore-loki -o yaml
kubectl get cephobjectstoreuser -n rook-ceph loki -o yaml

gh pr view 5027 -R proompteng/lab
gh pr view 5028 -R proompteng/lab
```

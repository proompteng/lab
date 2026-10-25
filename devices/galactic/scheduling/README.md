# Move Ceph clients off Ryzen and place CI on local storage

Ryzen is `talos-192-168-1-194`. Its Bosgame M5 chassis cannot provide a practical full-rate
100G NIC expansion path. See the [hardware evidence](../../ryzen/docs/bosgame-m5-talos-drivers.md#network-expansion-and-workload-placement).

Omni owns `network.proompteng.ai/100g=true` on Altra and Turin, and `false` on Ryzen.
Ryzen also has `workload.proompteng.ai/compute-local=true` and the matching
`true:NoSchedule` taint. A bandwidth-sensitive workload can require the 100G label
after the labels exist. The taint keeps application Ceph clients off Ryzen without
changing every operator-generated Pod template.

The `local-path` application owns the native `compute-local` MutatingAdmissionPolicy.
It adds the compute-local toleration to Pods without named PVCs or Ceph volume sources.
Generic ephemeral PVCs qualify only with an explicit local-path class from the policy's
allowlist. Missing PVCs and unspecified ephemeral classes do not qualify. Existing
tolerations, selectors, and affinity remain intact. This policy requires the cluster's
Kubernetes 1.37 API and no additional admission service.

Named local PVC consumers must opt in explicitly after verifying their class and bound PV.
Bayn's local-path TigerBeetle cluster moves to Altra and Turin and must not retain that opt-in. Do not add the toleration or a
blanket `Exists` toleration to applications with Ceph volumes. This taint is a scheduling
contract for reviewed workloads, not an authorization boundary against arbitrary Pod specifications.

DaemonSets need tolerations in their templates because their controller filters nodes
before Pod admission. The node networking, identity, metrics, GPU, and virtualization
agents retain Ryzen eligibility through their committed templates or existing tolerations.

Ceph's own services are exempt. Rook, its monitors, manager, exporters, and CSI components
remain eligible on Ryzen. The monitor placement retains all three hosts with
`allowMultiplePerNode: false`. No OSD disk placement or Ceph replication configuration changes.

## Check the migration before applying it

1. Confirm `galactic-lan` identity through the [access runbook](../../../docs/runbooks/galactic-kubernetes-access.md).
2. Run `python3 devices/galactic/scheduling/verify-placement.py --context galactic-lan` to list current Ceph clients on Ryzen.
3. Run `python3 devices/galactic/scheduling/verify-placement.py --context galactic-lan --probe-admission` to exercise
   the actual API's mutation logic. It creates a UUID-named policy and binding scoped to a unique test label in
   `local-path-storage`, submits only server-dry-run Pods, and removes both policy objects in a `finally` block.
   No application Pod or existing policy is changed. This probe requires PyYAML and cluster policy creation permissions.
4. Check fresh Altra and Turin NIC temperatures and run the [100G routing acceptance](../network/README.md).
   Require temperatures below the reported critical threshold before adding client traffic. Historical peaks do not
   establish the current temperature, and a negotiated 100G link alone does not prove sustained operation.
5. Keep the existing CPU/GPU memory split for the initial ARC move. Ryzen has 128GiB installed, with 64GiB reserved
   for the GPU and 61.8GiB allocatable. The initial two-Ryzen/three-Turin migration passed native acceptance; the
   authorized expansion places three AMD64 runners on Ryzen and six on Turin. Each reserves 16Gi and four logical
   CPUs. The 2026-10-12 inventory measured 11.94GiB and 6.57 logical CPUs for retained Ryzen workloads, giving about
   59.94GiB and 18.57 logical CPUs with three runners. The user permits memory overcommit; their combined limits
   remain 96Gi. Verify fresh requests and local filesystem free space before promotion. A later all-five move requires the
   [Bosgame memory repartition](../../ryzen/docs/bosgame-m5-talos-drivers.md#cpu-and-gpu-memory-allocation).

Three Ceph-backed database clusters, SPIRE server, and Restate retain three replicas but use preferred host separation
because only two application storage-client hosts remain. Bayn PostgreSQL must retain one instance on Altra and one
on Turin with required host separation; both architecture images must be validated before that rollout. Bayn status,
execution workers, and egress likewise span those hosts. Its three TigerBeetle replicas use a two-plus-one placement
across them, preserving replica identity and local data during the Ryzen handoff. No Bayn component belongs on Ryzen.
Torghut PostgreSQL currently retains its AMD64 restriction, so its two instances can share Turin. Preserve database
synchronous replication and writer fences; replica count is not the physical failure-domain count.

## Apply the reviewed desired state in order

Merge the storage and scheduling preparation first. Complete steps 1 through 5 before delivering the dependent ARC runner-placement configuration. Changes under `argocd/applications/arc/**` automatically build an image and enter Kargo promotion;
do not sync its Kargo revision before its local class and memory headroom exist.

1. Verify the exact merged revision and required CI. Reconcile the reviewed Rook and node-agent changes through their
   existing Argo applications. Confirm Ryzen's Ceph monitor remains in the three-monitor quorum and its node agents are ready.
2. Sync the manual `local-path` application to that revision. Require `local-path-ryzen`, the admission policy, and its binding
   to exist before changing Ryzen's scheduling configuration. The new class uses the existing XFS user volume at
   `/var/mnt/local-path-provisioner` with `WaitForFirstConsumer` and Ryzen-only topology.
3. Reconcile the reviewed database, SPIRE, and Restate affinity changes through their owning GitOps branches. Confirm all
   replicas are ready before moving any existing storage client. Kargo-managed applications use their Stage-generated branch.
4. Render, validate, dry-run, and sync the reviewed Omni template using the [Omni procedure](../omni/README.md).
   Preserve existing node IP configuration and labels. Require the 100G labels on Altra and Turin and the compute-local taint on Ryzen.
5. Move the inventoried Ceph client Pods one at a time through their operator's supported maintenance procedure.
   `NoSchedule` does not evict existing Pods. Respect PDBs, database switchover, Kafka quorum, CSI detach, and each workload's
   readiness before continuing. Cassandra retains its intentional `OnDelete` strategy. Do not drain Ryzen, delete PVCs,
   force detach volumes, or restart Ceph's monitor to perform this migration. A running Coder workspace needs its owner's
   maintenance window before its Ceph-backed Pod is recreated.
6. Keep Forgejo's AMD64 runner on Turin with its original Ceph registration PVC. Drain assigned jobs through the
   [Forgejo runner procedure](../../../argocd/applications/forgejo-runners/README.md) before its move.
7. Promote the reviewed ARC configuration through the existing `arc-runner` Kargo Stage after Ceph clients have left Ryzen.
   Keep the ARM64 sets on Altra; raise the normal `arc-arm64` maximum from five to eight and retain the separate
   analysis set's one-slot limit. Let busy AMD64 runners finish normally. One nine-runner `arc-amd64` set uses
   `local-path-ci-amd64`, whose node maps select Turin Transcend or Ryzen local scratch. Strict two-host spread and
   the 16Gi memory reservation with `maxSkew: 3` allow three on current Ryzen capacity and six on Turin. Require
   fresh non-runner Ryzen requests below 13.82GiB and no node pressure on any runner host. Revisit this reservation
   and spread before a BIOS memory change. Altra's ARM64 runners retain node-local workspaces; inspect its filesystem
   headroom and native image reclamation before increasing concurrency.
8. Run `python3 devices/galactic/scheduling/verify-placement.py --context galactic-lan --verify`.
   Require no application Ceph client on Ryzen, an AMD64 runner using only its local scratch claim, and the Ryzen monitor in quorum.
   Execute a non-publishing AMD64 CI job that writes scratch files, builds and runs a container, and executes Nix binaries.
   Check Ryzen etcd latency, memory pressure, CPU contention, and scratch I/O during three concurrent Ryzen builds and six concurrent Turin builds.
   Its local scratch partition shares the physical NVMe with `/var`.

## Live acceptance on 2026-10-12 UTC

The migration's native checks found no application Ceph client or Bayn Pod on Ryzen. Kafka, NATS, Loki, Mimir,
Tempo, Temporal dependencies, application databases, SPIRE, Restate, and the Coder workspace had moved to the
100G hosts with their durable claims retained. Ceph's own Ryzen monitor remained in the three-monitor quorum.

Bayn status, egress, and execution workers each spanned Altra and Turin. PostgreSQL's primary was on Altra with
a synchronous standby on Turin. TigerBeetle replicas 0 and 1 were on Turin and replica 2 on Altra. Replica 1's
existing local ledger was copied offline and verified before rebinding its retained PV; its PVC and replica
identity were preserved. Native checks confirmed the original plan and epoch, exact reconciliation, and the
existing capital grant. A temporary fail-closed execution hold during PostgreSQL switchover recovered through
the existing controller policy and activation hook.

The [five-slot ARC acceptance run](https://github.com/proompteng/lab/actions/runs/38207296252) completed five
concurrent AMD64 jobs: two on Ryzen and three on Turin, with 57 seconds of overlap across all five. Each job
verified Nix execution, a Docker build and container run, and its local XFS scratch volume. That initial revision
retained two idle runners and scaled to five jobs; five idle Pods were not required. Placement verification selects Pods
whose component is `runner`, because ARC listeners also carry the scale-set label but have no scratch PVC.

During that run Ryzen had at least 48.19GiB available memory, peaked at 3.06 CPU cores, and reported no node
pressure or memory full-stall time. One native API-to-etcd GET timed out while PostgreSQL rolled, so the strict
zero-error pressure check did not pass. This smoke test establishes the requested placement and concurrency;
it does not qualify sustained heavy-build latency. Ceph read-latency and scrub alerts remained a separate
operational issue at acceptance.

## Recover an interrupted rollout

### Transition existing required host separation

Changing a StatefulSet template from required to preferred host separation does not change its existing Pods.
During the three-host to two-host move, the first replacement can remain Pending: the two old Pods still require
their peers to use different hosts. This occurred for Tempo's block builders during the 2026-10-11 rollout.
The same dependency applies to its live stores and TigerBeetle's three-replica cluster.

Stage the affinity change before restricting these workloads to the two 100G hosts:

1. Capture the resource and Pod identities, current templates, PDB, and native health. On `AppProject/default`, add
   an owned `spec.syncWindows` entry with `kind: deny`, the affected Application names, `manualSync: true`, and a
   bounded UTC schedule and duration covering the transition. Guard the update with the project's UID and
   resourceVersion, preserve unrelated windows, and record the exact entry and owner annotation for removal.
   Verify it is **Active** with `argocd proj windows list default` and that each affected Application has no pending
   `operation` or Running/Terminating `status.operationState` before patching a workload. Finish or terminate an
   existing operation and verify it stopped first. The project window blocks automated sync and self-heal while
   allowing deliberate manual syncs; ApplicationSet reconciliation does not overwrite this project-level control.
   Do not rely on disabling automation only on a generated Application. Keep `arc` in the owned deny window until
   the final Ryzen storage and memory checks pass. See [Argo sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/).
2. For this authorized migration, temporarily apply the reviewed preferred affinity through the owning workload
   resource while retaining its existing three-host eligibility. Change only placement. Preserve images, replica
   identities, storage, labels, and the disruption budget. For TigerBeetle, update its cluster resource and let its
   operator reconcile the StatefulSet.
3. Let the controller replace one Pod at a time. A replacement that never scheduled under the old template can be
   recreated under the staged template only after confirming its UID, Pending state, absent node assignment, and
   absent started containers. Do not evict a second available replica or relax the PDB to clear this dependency.
4. Require all three replicas healthy and inspect every actual Pod's affinity. Updating only the controller
   template is insufficient. Require native partition progress for Tempo and native protocol health for TigerBeetle.
5. Reconcile the final 100G restriction from the reviewed owning GitOps revision. Kargo-managed workloads still use
   their generated branch and normal image-delivery gates. Complete the native data checks, then remove the owned
   transition controls with identity and original-value guards, preserving unrelated windows. Remove the owned
   cron entry rather than leaving it to recur next year. The temporary three-host eligibility is not retained as desired state.

For TigerBeetle, complete this affinity stage before the final restriction makes replica 1 Pending on its Ryzen PV.
Then follow the [retained ledger handoff](tigerbeetle-ledger1-handoff.md). Both surviving Pods must already use
preferred separation before the retained replica can join one of their hosts.

### Restore availability and desired state

Stop moving additional clients if quorum, readiness, or volume attachment checks fail. Preserve all claims and registrations.
For a placement regression, revert the reviewed Omni taint patch and affected GitOps configuration through their owners,
then verify node eligibility and restore unavailable replicas one at a time. Removing `NoSchedule` makes Ryzen eligible;
it does not move already running Pods. Reduce ARC capacity through its reviewed Kargo path if local disk or memory pressure
affects the control plane. Never delete busy runner Pods to reduce concurrency.

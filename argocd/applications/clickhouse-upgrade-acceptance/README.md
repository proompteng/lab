# ClickHouse upgrade acceptance

This Application owns isolated upgrade evidence and retained recovery snapshots.
ApplicationSet creates its restricted namespace; no Namespace object is rendered.
It does not own the serving ClickHouse installation or its credentials.

The preparation stage snapshots both original Torghut ClickHouse data PVCs after
native `BACKUP DATABASE default, DATABASE signal, DATABASE torghut` completed on
each replica. Each snapshot records the original PVC UID, native Backup ID and
the `.backup` manifest SHA256. Both replicas are required because their ordinary
MergeTree tables contain independent data. The snapshots retain the completed
native backup directories and never replace the serving volumes.

The next reviewed stage retains/imports the CSI handles and provisions dedicated
persistent restore and data claims. Engine containers run without service-account
tokens behind the namespace's default-deny policy, use loopback Keeper, and read
only the native backup from the snapshot. Native recovery, CHECK TABLE and full
row fingerprints must qualify 25.3, 25.8 and 26.3 before serving-image changes.

Use persistent claims sized for backup plus restored data. CI runners' Docker
graphs are temporary and bounded; do not place database rehearsals there. A prior
copy attempt exceeded that graph's 20 GiB limit and was rejected before native
restore qualification. Its partial copy is not recovery evidence.

Production remains Altinity Stable 25.3.6.10034 during preparation. The intended
sequence is 25.8.28.10001, then 26.3.16.10001, preserving synchronous inserts,
JSON integer formatting and documented downgrade compatibility settings. Any
recovery after activation must account for writes after the backup checkpoint.


The persistent rehearsal imports both completed CSI handles with Retain and
mounts each 50 GiB source clone read-only. Each replica has a separate 100 GiB
fixture claim and 1 GiB evidence claim. The three native versions restore the
same completed backup independently into distinct directories, with a private
loopback Keeper. This proves native backup recovery across the upgrade path;
it is not an in-place upgrade of a shared fixture directory.

Each engine restores structure first, pauses merges and TTL processing before
restoring data, checks every MergeTree table and fingerprints every row using
SHA256 of JSON tuples, count and four UInt64 sum/XOR lanes. Evidence includes
table/column catalogs, view queries, native CHECK TABLE results and graceful
server/Keeper exit codes. A final verifier compares all versions for each replica
and writes a JSON receipt to the evidence claim and its container log. The Job
cannot succeed without matching data and catalogs, successful native checks,
endpoint denials and zero native exit codes. Validate the receipt and retained
source identities before activation.

The namespace denies all ingress and egress. Start the checked-in controller on
an authorized workstation before merging this generation or requesting its sync:

```sh
python3 argocd/applications/clickhouse-upgrade-acceptance/control-runtime-isolation.py /path/to/evidence
```

Wait for its ACTIVE startup result and verify its fresh controller-ready.json
heartbeat before releasing the GitOps change. The controller performs live
positive controls and verifies namespace access before advertising readiness;
it can wait safely while no Jobs exist. Keep it running until both Jobs finish.

Before every native engine starts, the controller resolves the current production
Pods and proves TCP reachability. It then releases that engine's denied probes,
rechecks the exact Pod UIDs and addresses, and proves TCP reachability again.
The complete before/probe/after window must be at most 90 seconds. Native Jobs
wait for these runtime controls and cannot accept captured pre-merge IPs. The
controller collects completed native receipts and exits after both Jobs pass.
It never applies manifests or changes serving workloads. Containers use
UID 101, read-only roots, no capabilities and no service-account tokens. A failed
attempt does not retry or overwrite partial evidence. Diagnose it and review a
new generation. No CI runner or serving PVC is used as writable scratch space.


Keeper preparation retains a CSI snapshot of the original 1 GiB Keeper claim,
including its native snapshot and Raft logs. The recorded native snapshot SHA256
and original PVC identity must match the isolated recovery copy. The serving
Keeper whitelist does not enable `csnp`; preparation preserves that whitelist
and does not claim to have requested a new native snapshot. Source 25.12.5.44
recovery and target 26.8.2.7 recovery must both pass before serving activation.
The Keeper image, server ID, peer configuration and production PVC are unchanged
during this stage. After activation, recovery must account for subsequent writes.


Generation v1 stopped before starting either database because its network gate
accepted only a timeout. Galactic's network policy also returns an immediate
ECONNREFUSED rejection. Generation v2 accepts only timeout status 124 or status 1
with the native Connection refused error for that exact endpoint. Other command
errors remain failures. All five endpoints still require matching Pod UIDs and
successful production controls before and after the denied attempts.

Generation v2 uses new Job and ConfigMap names and fresh `/fixture/v2` and
`/proof/v2` directories on the same retained claims. The v1 directories and
source snapshots remain intact. `failed-generation-v1.json` preserves the
failed Job/Pod identities and logs. Retire only the two recorded failed v1 Jobs
after this change removes them from desired state; preserve all claims and
snapshots. They are rehearsal Jobs, not CI runner Jobs or serving workloads.
Restart the runtime controller with the v2 code before releasing this generation.


Keeper's native rehearsal recovers the retained snapshot and Raft logs with
25.12.5.44, then starts 26.8.2.7 on those same isolated files. It preserves server
ID 0, the original peer hostname and native UUID. A Pod host alias maps that
hostname to loopback; all native listeners and peers remain local. The existing
namespace default deny applies, with separate current positive/negative/positive
checks for both serving ClickHouse replicas and Keeper client/Raft ports.

Run the controller before merging the Keeper generation:

```sh
python3 argocd/applications/clickhouse-upgrade-acceptance/control-runtime-isolation.py /path/to/keeper-evidence argocd/applications/clickhouse-upgrade-acceptance/keeper-runtime-profile.json
```

The source volume is read-only. Native snapshots, logs and identity files must
match their copied checksums. After original ephemeral sessions expire, a
persistent native canary is created only in the isolated Keeper. The target must
recover the same canary value, stat and ACL, original UUID, root metadata and
recursive child counts, with healthy native quorum and clean process exits.
These checks verify native recovery and the in-place version transition; they
do not claim a fingerprint of every individual znode value. Final serving
acceptance also requires both ClickHouse clients and replicated tables healthy.
The source image, production PVC, credentials and Raft membership are unchanged
during this stage. Preserve the retained recovery checkpoint and account for
subsequent acknowledged writes before any recovery cutover.

A separate read-only Job prints the retained native server and private Keeper
logs from ClickHouse generation v2. Both v2 databases stopped on a readonly
replica during data restoration. This readout allows diagnosis without reopening
either database or modifying the failed fixture and evidence claims.


Generation v3 fixes the confirmed v2 restore failure: each private ClickHouse
server now advertises its required replication HTTP port on loopback and waits
for all eleven replicas to leave readonly/session-expired state before restoring
data. Native failures print bounded engine logs as well as retaining the complete
logs on the evidence claim. The v3 Jobs use fresh fixture/proof directories;
failed v2 Jobs and all snapshot/PVC data remain retained until their recorded
failed Job objects are retired separately.

Keeper generation v2 reruns the same retained recovery checkpoint in fresh
fixture/proof directories. Generation v1 completed native 25.12 recovery, then
its 26.8 phase timed out waiting for the workstation controller. The controller
now tolerates a successfully completed init container during a control read by
rechecking the same Pod UID and native exit code; other failures still stop it.
Keep both controllers alive through their final receipts and store workstation
evidence on persistent storage. This change does not modify serving workloads,
source snapshots, source credentials, network policy or retained claims.

The completed/failed Keeper v1 Job remains explicitly declared with Prune=false
and Delete=false while v2 runs. Its original Pod identity, statuses and logs
remain available until a separately recorded retirement.


Replica 0 generation v3 stopped before structure recovery because the private
Keeper had not yet accepted sessions. The readiness loop now requires a native
`system.zookeeper` query as well as the server version before RESTORE. Only failed
replica 0 gets a new v4 Job and fresh directories. Replica 1 continues in v3;
its current engine retains its open script file, and later init containers read
the updated ConfigMap after Kubernetes publishes it atomically. Data validation,
private endpoints and all native isolation checks remain unchanged.

Start the default controller for v4 replica 0. Keep a second controller running
for the existing replica 1 Job with `clickhouse-replica1-runtime-profile.json`.
Neither controller restarts or overwrites a completed phase. Compare all three
native versions independently for each replica before serving activation.

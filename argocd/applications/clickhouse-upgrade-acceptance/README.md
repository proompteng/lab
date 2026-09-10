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

The namespace denies all ingress and egress. Run the checked-in controller from
an authorized workstation after sync:

```sh
python3 argocd/applications/clickhouse-upgrade-acceptance/control-runtime-isolation.py /path/to/evidence
```

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

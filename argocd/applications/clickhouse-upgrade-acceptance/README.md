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

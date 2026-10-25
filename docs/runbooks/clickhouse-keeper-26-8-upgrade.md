# Torghut Keeper 26.8 upgrade

Upgrade the existing singleton from 25.12.5.44 to the pinned 26.8.2.7 image through
the Torghut build cohort, Kargo promotion and Argo reconciliation. Preserve CHK
`85c03015-f953-40b0-89fd-91b9e936bef6`, PVC `f9f4873a-c20c-4e4e-af28-4ff44f3d0df7`,
server ID 0, Raft peer `chk-torghut-keeper-default-0-0:9444` and UUID
`64b0e4c6-eacd-4839-9d82-a324d2300d75`. The corrected PDB selector matches the
operator's `clickhouse-keeper.altinity.com/chk` label and keeps maxUnavailable 0.

The isolated native qualification Job `keeper-native-20260910-v2` passed on
2026-09-10 at 08:03:53 UTC. It recovered the native snapshot and logs in 25.12,
then upgraded those same isolated files to 26.8. All 23,381 znodes, recursive
counts, persistent canary value/stat/ACL, UUID and clean exits passed. Its source
snapshot SHA256 is `97a2ca37c571b1584af15f0928b571ca0c33e872e47f2284f9b9322eaec0fd30`.
The completed qualification receipts and available container logs are archived
with the campaign evidence. The subsequent authorized retirement removes the
Job and isolated proof/source claims; they are not recovery checkpoints. Original
production snapshots and their retained contents remain available. See the
[retirement procedure](cluster-stable-upgrades-2026-09.md#retiring-upgrade-test-resources).

Before merging, verify retained VolumeSnapshot `keeper-production-26-8-20260910`
is ReadyToUse with bound content. It was created from the original 1Gi PVC while
25.12 was serving. The manifest adopts that same checkpoint and prevents pruning.
Record its UID, content UID and timestamp with the before/after runtime evidence.

This singleton restarts during reconciliation. ClickHouse clients temporarily
reconnect and may queue writes. Accept only when the native version is 26.8.2.7,
Keeper reports its existing single-peer leader quorum, the same CHK/PVC/UUID and
server ID remain, and both ClickHouse replicas can query Keeper with no readonly,
expired-session or lost-part state and replication queues drain.

If the rollout fails, stop further upgrades and retain all original volumes,
checkpoints and logs. Do not downgrade the modified data directory or independently
rewind Keeper behind ClickHouse. Recovery must coordinate ClickHouse writers and
its matching metadata checkpoint, restoring into an isolated claim before any
serving cutover. Never force-delete the original PVC, PV or VolumeAttachment.

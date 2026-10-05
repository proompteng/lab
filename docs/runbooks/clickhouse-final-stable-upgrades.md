# Final ClickHouse stable upgrades

Upgrade the existing Altinity Stable deployment from 25.3.6.10034 through
25.8.28.10001 to 26.3.16.10001. Keeper 26.8.2.7 is already qualified and deployed.
Keep the original CHI, both 50 GiB data claims, credentials, replica identities,
users and application grants. Use the normal Torghut build cohort, Kargo Stage
and Argo reconciliation for each serving-image transition.

## Qualification and checkpoints

Before merging a serving-image change, require native restore qualification for
both original replicas at all three versions. Their ordinary MergeTree tables
contain independent data. The strict verifier compares every restored row using
SHA256 count/sum/XOR fingerprints, table engines, columns, view results, native
CHECK TABLE results, 11 healthy replicated tables, network isolation controls and
clean server/Keeper exits. A successful Pod status alone is insufficient.

Replica 1 passed the v4 generation. Replica 0 retains its completed v4 25.3 and
25.8 proof and uses the final isolated retry for 26.3. Require its final PASS
receipt before activating 25.8. The retries and immutable evidence are documented
in [the acceptance application](../../argocd/applications/clickhouse-upgrade-acceptance/README.md).

Native `BACKUP DATABASE default, DATABASE signal, DATABASE torghut` must finish
on each serving replica before taking its new CSI checkpoint. The committed
`clickhouse-upgrade-25-8-checkpoints.yaml` adopts those completed checkpoints and
records native Backup IDs, manifest SHA256 hashes and original PVC UIDs. Verify
ReadyToUse snapshots and the retained source identities before activation.
Retain the earlier native backups and original production snapshot checkpoints.
The completed rehearsal receipts and available logs are archived before the
[authorized retirement](cluster-stable-upgrades-2026-09.md#retiring-upgrade-test-resources)
removes the scratch rehearsal claims. Recovery uses a retained original snapshot
restored into a fresh isolated claim, rather than a deleted rehearsal volume.

## Production sequence

1. Accept Keeper 26.8.2.7 first: the original CHK/PVC/filesystem UUID, persistent
   canary value/stat/ACL, native peer identity and both clients must survive.
2. Deliver immutable Altinity Stable 25.8.28.10001 with `compatibility=25.3`,
   `async_insert=0` and `output_format_json_quote_64bit_integers=1`, matching the
   qualified phase. Require both serving replicas to finish the operator rollout.
3. Verify native version and image IDs, original claims and table identities,
   historical queries, a replicated write/read canary, application connections,
   healthy Keeper sessions and no lost parts or persistent replication backlog.
4. Take another native backup and CSI checkpoint on both 25.8 replicas before
   delivering immutable 26.3.16.10001. Use `compatibility=25.8`, keep synchronous
   inserts and JSON integer quoting, and explicitly preserve the required
   MergeTree serialization settings before writing new 26.3 parts.
5. Repeat production acceptance at 26.3. Remove only the task's canary objects
   after the retained source values and new writes have passed on both replicas.

The [25.8 release notes](https://docs.altinity.com/releasenotes/altinity-stable-release-notes/25.8/)
and [26.3 release notes](https://docs.altinity.com/releasenotes/altinity-stable-release-notes/26.3/)
describe compatibility changes. The settings above preserve existing behavior;
compatibility alone is not proof that every newly written storage format can be
read by an older binary. Do not skip a qualified intermediate version.

## Recovery

Stop subsequent activations if either replica loses access to its original data,
Keeper sessions, expected table catalog or application traffic. Retain failed
Jobs, native logs, snapshot handles and all original claims. Do not force-delete
Pods, PVCs, PVs or VolumeAttachments. Restore from the retained native backup into
separate recovery storage when necessary, and account for writes after the
checkpoint. Never independently rewind Keeper behind the serving ClickHouse data.

## 26.3 serialization gate

The final image retains `compatibility=25.8` in every application profile and
explicitly sets the MergeTree defaults `serialization_info_version=basic`,
`string_serialization_version=single_stream`,
`propagate_types_serialization_versions_to_nested_types=false`,
`object_serialization_version=v2`, and `dynamic_serialization_version=v2`.
These match the exact Altinity 26.3 source's reversed compatibility history for
25.8. They preserve the older part representation during the mixed-version
rollout; keep them in place after acceptance. No existing column uses deprecated
Object types or removed codecs, and no existing table uses LIVE VIEW.

Before the final activation, both serving replicas passed 25.8 native checks,
original CHI/PVC/table identities, application logins and historical reads under
all five users, effective compatibility settings, and a quorum-two replicated
write/read canary. The committed 26.3 checkpoint file adopts a fresh native
backup and ready CSI snapshot for each original 25.8 claim. Retain these and the
25.3 checkpoints. Verify the five effective MergeTree settings, both native
versions, the same data identities and grants, and application/replication
behavior again at 26.3 before completing the upgrade.

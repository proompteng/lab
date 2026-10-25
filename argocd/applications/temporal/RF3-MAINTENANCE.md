# Temporal Cassandra replication maintenance

The existing `temporal` keyspace uses SimpleStrategy with replication factor 1.
Its three healthy Cassandra processes do not provide redundant copies of every
partition. Expand to RF3 and complete full repair before any Cassandra remount
or binary upgrade.

Increasing RF1 to RF3 changes the read quorum before old data has reached the
new replicas. This migration therefore stops Temporal's frontend, history,
matching, and worker deployments through GitOps. Requests and workflow
processing pause during maintenance. Cassandra and Elasticsearch remain up;
no PVC, PV, or Cassandra Pod is deleted.

## Delivery order

Prepare and validate the maintenance and resume PRs before merging maintenance.
Keep the resume PR ready so the service can return promptly after repair.

1. Argo scales the four server deployments to zero at wave -20.
2. The quiesce Job at wave -15 confirms no server Pods remain, then flushes
   `temporal` on each Cassandra node.
3. Wave -12 creates three retained RBD snapshots after that flush. The RF3 Job
   checks snapshot readiness, source, class, generation, and creation time, plus
   the exact existing PVC and StatefulSet identities.
4. Wave -4 verifies three healthy Cassandra nodes and schema agreement, changes
   only the `temporal` keyspace to RF3, and runs `nodetool repair -full temporal`
   on each node in order. The Job fails closed if a server resumes early or a
   Cassandra Pod/PVC identity changes.
5. After the repair Job completes, verify RF3, all three nodes `UN`, schema
   agreement, and no pending streams. Merge the prepared resume change, which
   removes the zero-replica overrides. Keep the RF3 chart setting and retained
   snapshots. Completed Jobs stay completed on ordinary reconciliation.
6. Verify all four Temporal servers Ready, cluster health `SERVING`, workflow
   visibility, schema version 1.13, and an isolated workflow roundtrip before
   beginning any Cassandra storage remount or version change.

## Failure and recovery

If quiesce or backup fails before ALTER, inspect the failed Job; the original
RF1 data and volumes remain intact. Resume through the prepared GitOps change
only after confirming ALTER was not reached.

After ALTER, keep Temporal stopped until full repair has succeeded on every
node. Do not lower the replication factor as a rollback. Investigate the
specific repair failure before retrying. Repair attempts use versioned Job names;
`temporal-cassandra-rf3-repair-v1` is the first attempt. A failed Job remains
terminal, so its retry is a reviewed GitOps change:

1. Confirm the previous Job has a terminal `Failed` condition, zero active Pods,
   and no remaining repair process or streams on any Cassandra node. Capture
   its logs and verify the retained snapshots and volume identities.
2. Change only the repair Job's `metadata.name` in
   `preparation/cassandra-rf3.yaml` to the next unused version, such as
   `temporal-cassandra-rf3-repair-v2`.
   Keep all four Temporal deployments at zero replicas. Preserve the original
   quiesce Job, snapshot names, backup generation, and identity guards.
3. Render, run the maintenance tests, and deliver that change through its PR
   and GitOps. Argo creates the newly named Job; it does not require an
   imperative Job deletion or a forced sync. The same RF3/full-repair sequence
   revalidates its preconditions and repairs all three nodes, including those
   completed by the earlier attempt.
4. Carry the new repair Job name into the prepared resume PR. Resume only after
   the new attempt completes and the runtime checks above pass.

Do not delete the snapshots, PVCs, or PVs, or lower the replication factor.
Automatic Job retries remain disabled so a lost client connection cannot start
another repair before the previous Cassandra-side operation is inspected.

Later version overlays must preserve `replicationFactor: 3`. Remove the completed
maintenance Jobs in a reviewed later stage before changing their pinned
Cassandra 3.11.5 baseline; retain the backup snapshots until upgrade acceptance.

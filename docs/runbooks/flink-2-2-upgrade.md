# Flink 2.2 runtime upgrade

The Torghut TA, simulation and market-data archive jobs share the `torghut-ta`
image. Upgrade all three from Flink 2.0.1 to 2.2.1, using Kafka connector
5.0.0-2.2, JDBC connector 4.1.0-2.2 and the matching Hadoop S3 plugin. The
operator is already 1.15.0.

Flink 2.3.0 is the newest upstream engine release, but its
[Kafka documentation](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/connectors/datastream/kafka/)
explicitly reports that a connector is not available yet. Apache's
[release compatibility list](https://flink.apache.org/downloads/)
supports these released Kafka and JDBC connectors on 2.2. Use 2.2.1 until the
required connectors support 2.3; an engine release alone is insufficient for
this Kafka-dependent stack.

## Build and preservation

Both the Nix builder and development Dockerfile use Flink 2.2.1 with Java 21.
Nix pins the individual amd64 and arm64 image digests, reproducible Docker
archive hashes and the S3 plugin hash. Kafka client 4.2.0 is constrained to the
version used by Kafka connector 5; the legacy Confluent `7.5.4-ccs` artifact
uses a different version scheme and must not win dependency resolution.
The LZ4 capability rule selects Flink's maintained implementation instead of
bundling conflicting old and new implementations.

Keep the existing job entrypoints, topology, operator IDs, serializers,
parallelism, source topics, consumer groups, destinations and credentials.
All three jobs use `upgradeMode: savepoint`. Disable the operator's fallback to
last-state recovery so a failed savepoint blocks the version transition.
Unmatched state must remain an error; do not enable `allowNonRestoredState`.

## Rollout

1. Finish the ClickHouse 26.3 serving acceptance first. Verify all three Flink
   jobs are running, checkpoints are completing, and their original resource
   UIDs, current job IDs, source offsets and S3 checkpoint locations are recorded.
2. Take and retain a canonical savepoint of each running 2.0.1 job. Record the
   native REST completion, location and source job identity. Do not delete old
   checkpoints, savepoints or HA metadata.
3. Validate the Gradle tests, Kotlin lint, assembled application JAR, resolved
   dependency versions, Nix expressions and rendered Flink resources. Merge
   after exact-head CI and automatic review. The normal five-image Torghut
   build cohort, Kargo promotion and Argo reconciliation activate the change.
4. During reconciliation the operator must stop each old job with a successful
   savepoint and restore the new job from it. Do not bypass a failed state
   restore by switching to stateless mode or accepting unmatched state.
5. Verify the exact promoted source and image digest, unchanged deployment UIDs,
   native Flink 2.2.1 on every JobManager and TaskManager, and restored savepoint
   paths. Require running vertices, completed new checkpoints, assigned Kafka
   partitions and no state migration, connector linkage or sink errors. Check
   TA heartbeat progress and archive consumer progress when input is available.
   Argo health alone does not establish this acceptance.

## Recovery

If a job cannot take its savepoint, leave it on the old version and investigate
the failing checkpoint or sink. Keep the deployment identity and saved state.
If new-version restoration fails, retain its logs and the exact old savepoint;
deliver the previous runtime through the normal GitOps path and explicitly
restore that retained point. Do not assume a checkpoint written by 2.2 can be
read by 2.0. Any rewind must account for data already emitted after the selected
savepoint and the sinks' existing delivery semantics.

This upgrade does not change Bayn execution authority, enable its trading
controller, recreate the removed Torghut scheduler or rewrite market data.

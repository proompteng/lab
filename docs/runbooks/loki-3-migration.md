# Loki 3 migration

Loki 3.7.7 with community chart 18.12.1 owns production ingestion and queries.
The original gateway Service retains its address and selects the Loki 3 gateway.
The Loki 2.9.13 workloads are retired after their final buffer drain passed.

The migration used separate process rings: the releases are outside the
adjacent-version rolling upgrade path. Only object storage was shared. Keep
`migrate.fromDistributed` disabled and do not rejoin the retired memberlist.

## Storage and configuration

Keep the existing `2024-01-01` BoltDB Shipper v13 schema, `loki_index_` prefix,
24-hour index period, `loki-data` bucket, and credential references. Do not
rewrite that schema period or add a placeholder future period. Structured
metadata remains disabled until a separately verified TSDB migration.
Preserve the old admission limits and service labels during this transition.
Both versions select chunk format V4 for schema v13; verify cross-version
object reads before cutover. This does not assume cross-version RPC support.

The new deployment uses Loki's supported Thanos object-store client against
`rook-ceph-rgw-tls.rook-ceph.svc:443`, with certificate verification for
`ceph.k8s.proompteng.ai`. This reaches the same RGW Service and bucket through
the existing internal TLS proxy. It avoids the MinIO HTTP signing issue
described in the [RGW compatibility runbook](ceph-rgw-sigv4-compatibility.md).
Do not weaken certificate or SigV4 verification.
Disable storage request hedging (`storage_config.hedging.at: 0s`). In Loki
3.7.7, the Thanos adapter constructs its hedged GET transport from the Go
default transport, discarding the configured S3 TLS server name. The normal
S3 transport preserves certificate verification for both reads and writes.

Both new ingesters retain their WAL at `/var/loki/wal` on separate 20 GiB Ceph
claims, with retained PVCs and normal rolling updates. Keep replication factor
one without zone awareness during the version upgrade.
A single Loki 3 compactor owns index compaction, with a retained 10 GiB Ceph
working volume. No other compactor process was running before it was enabled.
Retention remains disabled; this upgrade does not add a log deletion policy or
a ruler. Keep the chart's standard compactor address in `commonConfig`.
Native `-verify-config` checks syntax and values; live module startup and a
successful compaction cycle remain separate acceptance gates.

## Migration gates

Capture original Pod UIDs, buffer/flush counters, and a historical log fixture
before deployment. Render with Helm 3, check the complete capacity requirement,
and verify the additive phase changes no existing resources. The generated
configuration precedes the native Loki `-verify-config=true` gate; workloads
must not start if that gate fails. The canary starts in a later sync wave after
the read/write components become healthy.

Require all new components Ready, both new ingesters ACTIVE in their separate
ring, successful object-store access, and increasing successful flush counters.
Verify that each ring contains only its own release's Pod addresses.
Read the captured historical entries through the new query path and compare
timestamps, labels, and line hashes. Write a unique fresh log through each
generation's endpoint and read it through that generation's query path.
Flush the fixture's ingester, wait for index shipping, and then read it
through the other generation's query path. The isolated rings cannot read
each other's unflushed buffers; cross-generation object reads prove durability.
The BoltDB writer hands over inactive 15-minute index shards with a one-minute
safety buffer. Allow the shard boundary, upload loop, and reader resync before
requiring a cross-ring object read; `/flush` closes chunks asynchronously and
does not immediately publish the active index shard.
Verify captured production entries using their exact labels, timestamps and
line hashes; late arrivals can change a global latest-results query. For an
object-only cross-ring check, use the old querier directly if its frontend
cached an empty result before index publication. Keep the normal new gateway
as the acceptance path for historical, fresh and captured production logs.

Observe the native canary for at least fifteen minutes after startup, with
increasing checked entries and no new missing, out-of-order, duplicate, or
query errors. Readiness and a successful push alone do not prove retention.

## Cutover and recovery

Only after those gates pass, flush the old ingester and verify that current
production logs are readable from the new query path. Route the original
gateway address to the new deployment through reviewed GitOps. In the next
sync wave, scale the old stateless gateway to zero so existing HTTP keep-alive
connections close and clients reconnect through the new Service endpoints.
Keep the old ingester running, then flush it again once its accepted-write
counter stops increasing.
Allow for index shipping when checking logs from the cutover interval.
Keep the old ingester until its remaining
chunks are durably flushed and the new query path reads them. Its `emptyDir`
must not be discarded to force a rollout. Preserve the original Pod UID while
collecting the drain evidence and verify the exact deployed version's native
flush/shutdown contract before retiring it.

The final retirement gate passed on 2026-09-09: the original ingester Pod UID
was unchanged, its accepted-write counters had stopped, its flush queue and
flush failures were zero, and 2,253 chunks were stored against 2,239 created
chunks (including recovered WAL data). All three captured final production
entries were read through the normal Loki 3 gateway with exact timestamps,
labels and line hashes. The pre-cutover canary window checked 3,201 additional
entries over 1,067 seconds with no new missing, duplicate, ordering or query
errors. Keep those startup-era lifetime counters intact when comparing deltas.

Enable the sole compactor only after confirming no other compactor process
exists. Wait for its native compaction interval and require an increasing
successful cycle count with no errors; readiness does not prove compaction.
Preserve compatibility Services and all object-store history when removing
the old release. Recheck fresh logs, historical fixtures, and canary counters
after final delivery. During recovery, retain both new WAL claims and every
object. Once endpoints switch, new ingesters own production writes; deleting
the new deployment is not a safe rollback.

Sources: [Loki upgrade guide](https://grafana.com/docs/loki/latest/setup/upgrade/)
and the schema-to-chunk-format contracts for
[2.9.13](https://github.com/grafana/loki/blob/v2.9.13/pkg/storage/config/schema_config.go)
and [3.7.7](https://github.com/grafana/loki/blob/v3.7.7/pkg/storage/config/schema_config.go).

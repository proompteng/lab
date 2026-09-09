# Loki 3 migration

Deploy Loki 3.7.7 with community chart 18.12.1 in a separate process ring
alongside Loki 2.9.13. Do not enable `migrate.fromDistributed` or join the old
memberlist Service: the releases are outside the adjacent-version rolling
upgrade path. Only object storage is shared. Production clients continue to
write to the original ingester until explicit endpoint cutover.

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

Both new ingesters retain their WAL at `/var/loki/wal` on separate 20 GiB Ceph
claims, with retained PVCs and normal rolling updates. Keep replication factor
one without zone awareness during the version upgrade.
The new compactor remains disabled until read/write acceptance passes. The
original deployment has no running compactor; verify that again before
enabling the new sole compactor. No ruler is added by this migration.
Keep the chart's standard compactor address in `commonConfig` during this
pause. Loki's query modules require a configured address even when no
compactor is running and retention is disabled. `-verify-config` validates
configuration syntax and values; live module startup remains an acceptance
gate and must not be inferred from that check alone.

## Deployment and acceptance

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

Observe the native canary for at least fifteen minutes after startup, with
increasing checked entries and no new missing, out-of-order, duplicate, or
query errors. Readiness and a successful push alone do not prove retention.

## Cutover and recovery

Only after those gates pass, flush the old ingester and verify that current
production logs are readable from the new query path. Route the original
gateway address to the new deployment through reviewed GitOps, then flush
the old ingester again once its accepted-write counter stops increasing.
Allow for index shipping when checking logs from the cutover interval.
Keep the old ingester until its remaining
chunks are durably flushed and the new query path reads them. Its `emptyDir`
must not be discarded to force a rollout. Preserve the original Pod UID while
collecting the drain evidence and verify the exact deployed version's native
flush/shutdown contract before retiring it.

Enable the sole compactor after confirming no other compactor process exists.
Preserve compatibility Services and all object-store history when removing
the old release. Recheck fresh logs, historical fixtures, and canary counters
after final delivery. During recovery, retain both new WAL claims and every
object. Once endpoints switch, new ingesters own production writes; deleting
the new deployment is not a safe rollback.

Sources: [Loki upgrade guide](https://grafana.com/docs/loki/latest/setup/upgrade/)
and the schema-to-chunk-format contracts for
[2.9.13](https://github.com/grafana/loki/blob/v2.9.13/pkg/storage/config/schema_config.go)
and [3.7.7](https://github.com/grafana/loki/blob/v3.7.7/pkg/storage/config/schema_config.go).

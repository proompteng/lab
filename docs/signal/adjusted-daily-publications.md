# Signal adjusted-daily publications

Signal owns the point-in-time capture of adjusted Alpaca daily bars consumed by Bayn. The publisher is a bounded batch
program, not a long-running service. Its immutable image supports two commands:

- `daily`: select the latest Alpaca exchange session whose close is at least the configured lag in the past.
- `backfill --start YYYY-MM-DD --end YYYY-MM-DD`: publish one explicitly bounded historical capture.

Both commands fetch the Alpaca calendar and paginated bars from the explicitly configured feed, runtime-decode every
response, and apply the same domain validation. Production uses consolidated SIP only after Alpaca's Basic-plan
15-minute delay has elapsed. The daily GitOps CronJob runs at 18:30 `America/New_York`, forbids overlap, and uses
deterministic insert deduplication. Its historical query ends at the earlier of the session-date boundary or 15 minutes
before invocation, satisfying Alpaca's Basic-plan delay without admitting an unfinished session. Publisher writes
require both ClickHouse replicas to acknowledge each insert, and readback uses sequential consistency before the
manifest is appended. It has no broker, TigerBeetle, PostgreSQL, or capital authority.

## Finalization contract

Each capture creates a content-addressed 64-hex SHA-256 snapshot. The identity binds provider, feed, adjustment,
calendar version, requested bounds, symbol set, ordered bar hash, and ordered exchange-session hash. A retry with the
same content reuses the same identity.

The publisher stages rows in these additive replicated tables:

- `signal.adjusted_daily_bars_v2`
- `signal.exchange_sessions_v1`
- `signal.snapshot_manifests_v2`

Only after exact database readback does it append one manifest row. Manifest presence is the finalization boundary. A
V2 manifest binds the configured universe ID and canonical SHA-256 symbol hash in both its content identity and stored
columns. A partial run is not finalized; an exact retry resumes it. Duplicate keys, unexpected rows, changed values,
multiple manifests, or a hash mismatch invalidate the snapshot instead of replacing it.

Every returned exchange session must contain exactly one valid OHLCV bar for every configured symbol. All bars must
fall on a returned exchange session and inside the requested bounds. Any historical or final symbol-session gap blocks
finalization; gaps are never dropped, synthesized, or hidden behind manifest counts.

`publication_asof` records the last included session. The immutable snapshot is a capture of what Alpaca returned at
`finalized_at`; it is not a claim that Alpaca provides a historical vendor-revision time machine. The provider `asof`
parameter is supplied explicitly for symbol mapping.

The provider contract follows Alpaca's [historical bars](https://docs.alpaca.markets/us/v1.4.2/reference/stockbars),
[trading calendar](https://docs.alpaca.markets/us/v1.1/reference/getcalendar-1), and
[market-data feed](https://docs.alpaca.markets/us/docs/market-data-faq) documentation. The publisher requests
`adjustment=all`, explicitly records either `iex` or `sip`, exhausts pagination, and uses the returned session close so
early-close days are not treated as ordinary 16:00 sessions. The current production selection is delayed `sip`; live
IEX websocket events retain a different feed identity and are never relabeled as strategy input.

## Authority

The `signal_publisher` ClickHouse principal has only `SELECT, INSERT` on the current publication tables and the legacy
V1 manifest retained for rollback. It cannot create, alter, truncate, drop, or access all tables through a wildcard.
Schema creation is an additive GitOps migration using the existing administrative identity. Bayn has only explicit
`SELECT` grants on the legacy and current read paths and cannot mutate Signal data.

## Operator invocation

Run a historical publication only through a reviewed one-off GitOps Job using
`backfill --start <date> --end <date>`. Keep the same versioned universe ConfigMap, secrets, and immutable image
reference as the CronJob. Remove the completed Job through GitOps after retaining its snapshot evidence. Never run the
removed Bayn backfill path or grant Bayn write access.

## Rollout, evidence, and rollback

GitOps creates the sealed writer credential, applies the least-privilege ClickHouse user, runs the additive schema hook,
and normally renders only the scheduled CronJob. A suspended CronJob is not retained because Argo marks it `Suspended` and waits
indefinitely for `Healthy`. The ClickHouse operator may restart replicas sequentially when its user configuration
changes; verify both replicas before promotion. Image promotion pins the source SHA and multi-platform digest without
changing scheduled-writer activation.

When a historical publication is required, a separate reviewed GitOps change creates one bounded Job with a unique
name. Prevent overlap with the scheduled writer: either leave the CronJob inactive for that interval, or enforce an
absolute start deadline that leaves the Job's full `activeDeadlineSeconds` before the next scheduled run. The Job must
check that deadline before importing the publisher or making external calls. Keep the completed Job until its
resource is removed through GitOps; a TTL would let Argo recreate it. Never resume or reapply a completed Job under
the same name; Kubernetes Job templates are immutable.

The October 13 recovery completed at 17:02:01 UTC on its first attempt, publishing January 4, 2016 through
October 12, 2026. Source `864e832055368f64e1cbacfef257c11e62717311` produced snapshot
`2c0e62168fa44be12852b348f6f5601e4b7486736c307c108acfc66b8af974dd` with 13,545 bars and 2,709 exchange sessions
for the five-symbol `cross-asset-taa-v1` universe. Independent readback verified the canonical bar, session and
manifest hashes on both replicas, with exactly one manifest and no duplicate keys per replica. The completed Job
and its provenance replacements were removed through GitOps after retaining its logs and verification receipt.
The scheduled writer remains active; the base application retains no dormant backfill Job.

The original recovery failed on a 120-second server deadline and a 60-second quorum wait. The scheduled writer now
allows one hour with three retries. Each insert keeps two-replica quorum and derives its 144-second quorum wait and
162-second server clock limit from the unchanged 180-second client budget. Unknown outcomes remain partial; a retry
verifies retained rows and inserts only the exact missing rows. A timeout or Job retry cannot finalize a snapshot.
The recovery's existing CronJob owner reference recorded its genuine completion in `lastSuccessfulTime`; it does
not substitute for the two scheduled observations required below.

`SignalAdjustedDailyPublicationMissed` alerts when the latest scheduled run remains newer than the last successful
completion for two hours, followed by a five-minute hold. That budget covers the CronJob's one-hour start deadline
and one-hour active lifetime. The alert also handles a first scheduled run that has never succeeded, deduplicates
kube-state-metrics replicas, resolves after a successful owned recovery, and stays clear over weekends after success.
The collector retains both CronJob timestamps; no additional Kubernetes permissions or Job collector are required.

Completion evidence requires the bounded backfill plus two distinct scheduled publication observations. For each one,
retain the Job name, source revision, image digest, universe ID and symbol hash, snapshot ID, publication as-of date,
exact row counts and hashes, one manifest row, and duplicate-key readbacks from both ClickHouse replicas. Also prove
the publisher's explicit `SELECT, INSERT` grants and that Bayn cannot insert.

Rollback is fail-closed: suspend the active writer through GitOps, preserve finalized and partially staged rows for
diagnosis, and revert publisher or user manifests only after no Job is active. Do not delete either the legacy table or
the additive snapshot tables. Bayn remains bound to its configured finalized snapshot until a separately reviewed
GitOps change selects another one.

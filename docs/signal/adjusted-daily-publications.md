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

GitOps first creates the sealed writer credential, applies the least-privilege ClickHouse user, runs the additive schema
hook, and leaves both writer templates dormant and unrendered. A suspended CronJob is not retained because Argo marks
it `Suspended` and waits indefinitely for `Healthy`. The ClickHouse operator may restart replicas sequentially when its
user configuration changes; verify both replicas before promotion. Image promotion pins the source SHA and
multi-platform digest in both writer templates but activates nothing.

A separate reviewed GitOps change adds and starts only the one-shot backfill Job. The CronJob remains absent until the
bounded snapshot is reproduced from both replicas. Cleanup then removes the completed Job and renders the enabled
CronJob in one commit. CI rejects a rendered suspended writer, an active unrendered writer, an active writer without
immutable provenance, or simultaneous active backfill and scheduled writers.

Completion evidence requires the bounded backfill plus two distinct scheduled publication observations. For each one,
retain the Job name, source revision, image digest, universe ID and symbol hash, snapshot ID, publication as-of date,
exact row counts and hashes, one manifest row, and duplicate-key readbacks from both ClickHouse replicas. Also prove
the publisher's explicit `SELECT, INSERT` grants and that Bayn cannot insert.

Rollback is fail-closed: suspend the active writer through GitOps, preserve finalized and partially staged rows for
diagnosis, and revert publisher or user manifests only after no Job is active. Do not delete either the legacy table or
the additive snapshot tables. Bayn remains bound to its configured finalized snapshot until a separately reviewed
GitOps change selects another one.

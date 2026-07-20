# Signal adjusted-daily publications

Signal owns the point-in-time capture of adjusted Alpaca daily bars consumed by Bayn. The publisher is a bounded batch
program, not a long-running service. Its immutable image supports two commands:

- `daily`: select the latest Alpaca exchange session whose close is at least the configured lag in the past.
- `backfill --start YYYY-MM-DD --end YYYY-MM-DD`: publish one explicitly bounded historical capture.

Both commands fetch the Alpaca calendar and paginated consolidated SIP bars, runtime-decode every response, and apply
the same domain validation. The daily GitOps CronJob runs at 18:30 `America/New_York`, forbids overlap, and uses
deterministic insert deduplication. Its historical query ends at the earlier of the session-date boundary or 15 minutes
before invocation, satisfying Alpaca's Basic-plan delay without admitting an unfinished session. Publisher writes
require both ClickHouse replicas to acknowledge each insert, and readback uses sequential consistency before the
manifest is appended. It has no broker, TigerBeetle, PostgreSQL, or capital authority.

## Finalization contract

Each capture creates a content-addressed `signal-v1-<sha256>` snapshot. The identity binds provider, feed, adjustment,
calendar version, requested bounds, symbol set, ordered bar hash, and ordered exchange-session hash. A retry with the
same content reuses the same identity.

The publisher stages rows in these additive replicated tables:

- `signal.adjusted_daily_bars_v2`
- `signal.exchange_sessions_v1`

Only after exact database readback does it append one row to `signal.snapshot_manifests_v1`. Manifest presence is the
finalization boundary. A partial run is not finalized; an exact retry resumes it. Duplicate keys, unexpected rows,
changed values, multiple manifests, or a hash mismatch invalidate the snapshot instead of replacing it.

The final session must contain exactly one valid OHLCV bar for every configured symbol. All bars must fall on a returned
exchange session and inside the requested bounds. Historical symbol-session gaps before the final session remain
visible in the manifest counts and hashes; they are not synthesized.

`publication_asof` records the last included session. The immutable snapshot is a capture of what Alpaca returned at
`finalized_at`; it is not a claim that Alpaca provides a historical vendor-revision time machine. The provider `asof`
parameter is supplied explicitly for symbol mapping.

The provider contract follows Alpaca's [historical bars](https://docs.alpaca.markets/us/v1.4.2/reference/stockbars),
[trading calendar](https://docs.alpaca.markets/us/v1.1/reference/getcalendar-1), and
[market-data feed](https://docs.alpaca.markets/us/docs/market-data-faq) documentation. The publisher requests
`adjustment=all`, explicitly selects the consolidated `sip` feed, exhausts pagination, and uses the returned session
close so early-close days are not treated as ordinary 16:00 sessions. IEX remains a development override, not the
production publication source.

## Authority

The `signal_publisher` ClickHouse principal has only `SELECT, INSERT` on the three publication tables. It cannot create,
alter, truncate, or drop objects. Schema creation is an additive GitOps migration using the existing administrative
identity. Bayn has only `SELECT` on the legacy table and all three publication tables.

## Operator invocation

Run a historical publication from the promoted image by creating a one-off Job from the CronJob and replacing its
arguments with `backfill --start <date> --end <date>`. Keep the same secrets and immutable image reference. Never run
the removed Bayn backfill path or grant Bayn write access.

## Rollout, evidence, and rollback

GitOps first creates the sealed writer credential, applies the least-privilege ClickHouse user, runs the additive schema
hook, and leaves the CronJob suspended. The ClickHouse operator may restart replicas sequentially when its user
configuration changes; verify both replicas before promotion. Image promotion pins the source SHA and multi-platform
digest and is the only step that unsuspends the schedule.

Completion evidence requires two distinct scheduled publication observations. For each one, retain the Job name,
source revision, image digest, snapshot ID, publication as-of date, exact row counts and hashes, one manifest row, and
duplicate-key readbacks from ClickHouse. Also prove the publisher has only its three `SELECT, INSERT` grants and Bayn
cannot insert.

Rollback is fail-closed: suspend the CronJob through GitOps, preserve finalized and partially staged rows for diagnosis,
and revert the publisher/user manifests only after no Job is active. Do not delete either the legacy table or the
additive snapshot tables. Bayn continues to read `adjusted_daily_bars_v1` until its separate finalized-snapshot reader
ticket is deployed.

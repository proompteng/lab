# Signal Publisher

Publishes finalized, content-addressed Alpaca adjusted-daily snapshots and exchange-session manifests to Signal
ClickHouse. The feed, versioned universe ID, and canonical symbol hash are explicit in every V2 snapshot; production
uses delayed consolidated SIP after the session is finalized. It is the only writer for its three current publication
tables, and Bayn consumes them read-only.

The same binary supports `daily` and the explicitly bounded `backfill --start DATE --end DATE` command. Production
runs use immutable promoted images and renders only the scheduled writer. A historical backfill requires a reviewed
one-off Job with a unique name; it is removed after completion and never retained as an inert base manifest. See
[`docs/signal/adjusted-daily-publications.md`](../../docs/signal/adjusted-daily-publications.md) for the data
contract and operating procedure.

```sh
bun run --filter @proompteng/signal-publisher test
bun run --filter @proompteng/signal-publisher tsc
bun run --filter @proompteng/signal-publisher lint
bun run --filter @proompteng/signal-publisher lint:oxlint
bun run --filter @proompteng/signal-publisher lint:oxlint:type
bun run --filter @proompteng/signal-publisher build
```

Quorum inserts group bars and exchange sessions by the tables' yearly `session_date` partition, then split each year
into batches of at most 5,000 rows. Symbol-ordered input therefore does not create a new part for the same year in
each mixed-year batch. Each insert retains deterministic content deduplication, both-replica acknowledgment and
sequentially consistent readback. Finalization still verifies every staged row before appending the manifest.

Each insert derives its quorum wait and server execution limit from the configured client request budget: 80% for
quorum, 90% for server clock time, then the full client timeout. The production 180-second budget therefore allows
144 seconds for quorum and 162 seconds on the server. Query profile counters are enabled for these writes, and each
acknowledged batch logs its query ID, row count and elapsed time. Scheduled and recovery Jobs allow one hour for
bounded retries, preserving exact partial-stage recovery after an unknown write outcome.

# Signal Publisher

Publishes finalized, content-addressed Alpaca adjusted-daily snapshots and exchange-session manifests to Signal
ClickHouse. The feed, versioned universe ID, and canonical symbol hash are explicit in every V2 snapshot; production
uses delayed consolidated SIP after the session is finalized. It is the only writer for its three current publication
tables, and Bayn consumes them read-only.

The same binary supports `daily` and the explicitly bounded `backfill --start DATE --end DATE` command. Production
runs use immutable promoted images and renders only the scheduled writer. A historical backfill requires a reviewed
one-off Job with a unique name; it is removed after completion and never retained as an inert base manifest. See
[`docs/bayn/signal-adjusted-daily-publications.md`](../../docs/bayn/signal-adjusted-daily-publications.md) for the data
contract and operating procedure.

```sh
bun run --filter @proompteng/signal-publisher test
bun run --filter @proompteng/signal-publisher tsc
bun run --filter @proompteng/signal-publisher lint
bun run --filter @proompteng/signal-publisher lint:oxlint
bun run --filter @proompteng/signal-publisher lint:oxlint:type
bun run --filter @proompteng/signal-publisher build
```

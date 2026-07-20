# Signal Publisher

Publishes finalized, content-addressed Alpaca adjusted-daily snapshots and exchange-session manifests to Signal
ClickHouse. It is the only writer for its three owned tables; Bayn consumes them read-only.

The same binary supports `daily` and the explicitly bounded `backfill --start DATE --end DATE` command. Production
runs use the GitOps CronJob and an immutable promoted image. See
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

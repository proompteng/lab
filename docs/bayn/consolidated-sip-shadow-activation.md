# Consolidated SIP shadow activation

**Keep IEX primary while qualifying SIP.** Wave 9E verifies what landed in the archive; it does not change feeds,
enable the [Wave 9B ETF strategy upgrade](https://github.com/proompteng/lab/pull/16393), or grant broker or capital
authority. Roll out the shadow lane and any later primary cutover only through the reviewed
[release process](../release-automation.md).

## Enable the separate capture and archive routes

Use the [Wave 4H manifest](../../services/bayn/src/market-data/sip/universe.ts) merged in
[#16390](https://github.com/proompteng/lab/pull/16390). From the repo root, obtain the exact uppercase CSV (no
whitespace, blank entries, trailing comma, or newline in the hashed input):

```sh
sip_symbols="$(bun -e 'import { sipUniverse } from "./services/bayn/src/market-data/sip/universe"; console.log(sipUniverse.all73.join(","))')"
printf '%s' "$sip_symbols" | sha256sum
```

The digest must be `89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b`.

### Dorvud WebSocket forwarder

Use a **separate** equity forwarder with one replica and one upstream SIP WebSocket owner. Set the following
[Wave 7B](https://github.com/proompteng/lab/pull/16384) environment values on that instance only:

| Variable                                                                 | Value                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `ALPACA_MARKET_TYPE`                                                     | `equity`                                                                |
| `ALPACA_FEED`                                                            | `sip`                                                                   |
| `ALPACA_STREAM_URL`                                                      | `wss://stream.data.alpaca.markets` (default)                            |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`                                     | Existing secret references for the verified SIP-entitled Alpaca account |
| `ALPACA_MARKET_DATA_ENTITLEMENT`                                         | `algo_trader_plus`                                                      |
| `ALPACA_MARKET_DATA_CHANNELS`                                            | `bars,quotes,trades` (219 subscriptions)                                |
| `SHARD_COUNT`, `SHARD_INDEX`                                             | `1`, `0`                                                                |
| `SYMBOLS`, `SYMBOLS_ALLOWLIST`                                           | Exact `sip_symbols` CSV, both variables identical                       |
| `MARKET_DATA_UNIVERSE_ID`                                                | `torghut-core-equity-sip-v1`                                            |
| `MARKET_DATA_UNIVERSE_SYMBOL_HASH`                                       | `89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b`      |
| `TOPIC_BARS_1M`                                                          | `bayn.market-data.sip.bars.1m.v1`                                       |
| `TOPIC_QUOTES`                                                           | `bayn.market-data.sip.quotes.v1`                                        |
| `TOPIC_TRADES`                                                           | `bayn.market-data.sip.trades.v1`                                        |
| `TOPIC_STATUS`                                                           | `bayn.market-data.sip.status.v1`                                        |
| `ENABLE_BARS_BACKFILL`, `ENABLE_TRADES_BACKFILL`, `ENABLE_TRADE_UPDATES` | `false` for the qualification window                                    |

Leave `ALPACA_LATEST_SYMBOLS`, `ALPACA_OBSERVATION_SYMBOLS`, `ALPACA_OBSERVATION_FEEDS`, `JANGAR_SYMBOLS_URL`, and
the per-channel `ALPACA_MARKET_DATA_*_SYMBOLS` overrides unset on the shadow instance. Use its approved Kafka
connection and isolated topics. Never add SIP as an observation feed to the IEX instance. The paid declaration
sets a local ceiling of 400; `ALPACA_MAX_SYMBOL_CHANNELS=219` can explicitly constrain it. Neither setting grants
provider entitlement. Confirm the authenticated subscription acknowledgment covers the roster on all three
channels. Errors 405, 406, and 409 stop the SIP reconnect loop: fix the roster, connection ownership, or
entitlement respectively before restarting. See the [forwarder contract](../../services/dorvud/README.md#consolidated-sip-shadow-forwarder).

### Flink MarketDataArchiveJob

Keep `ARCHIVE_CORE_FEED=iex` and the existing core topics, universe, consumer group, and checkpoint identities.
Set all six [Wave 8B](https://github.com/proompteng/lab/pull/16389) settings together:

| Variable                                  | Value                                                              |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `ARCHIVE_SIP_SHADOW_UNIVERSE_ID`          | `torghut-core-equity-sip-v1`                                       |
| `ARCHIVE_SIP_SHADOW_UNIVERSE_SYMBOLS`     | Exact same `sip_symbols` CSV                                       |
| `ARCHIVE_SIP_SHADOW_UNIVERSE_SYMBOL_HASH` | `89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b` |
| `ARCHIVE_SIP_SHADOW_BARS_TOPIC`           | `bayn.market-data.sip.bars.1m.v1`                                  |
| `ARCHIVE_SIP_SHADOW_QUOTES_TOPIC`         | `bayn.market-data.sip.quotes.v1`                                   |
| `ARCHIVE_SIP_SHADOW_TRADES_TOPIC`         | `bayn.market-data.sip.trades.v1`                                   |

Provision the approved topics and restore the archive with the new routes before the first session's open. Confirm
it consumes and persists SIP and that IEX still advances. Verify the deployed revision, consumer lag, checkpoint
health, archive rejects, and actual per-feed rows, not just readiness. Keep the existing sinks; no new tables,
schema writes, or ad hoc backfills are part of verification. See the
[archive contract](../../services/dorvud/technical-analysis-flink/README.md#parallel-consolidated-sip-shadow-archive).

## Verify five consecutive completed trading sessions

Run from a pinned checkout with Bun 1.4.2 and the locked dependencies. Use an approved ClickHouse reader (SELECT
on `signal.intraday_bars_1m_v2` and `signal.intraday_quotes_v1` only) and a calendar-capable Alpaca credential.
Inject these through the existing secret path; do not paste them into command arguments, reports, or shell traces.

| Variable                                               | Purpose                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `BAYN_CLICKHOUSE_URL`                                  | Native ClickHouse HTTP(S) endpoint, no URL credentials, query, or fragment; use the approved TLS or private endpoint |
| `BAYN_CLICKHOUSE_USERNAME`, `BAYN_CLICKHOUSE_PASSWORD` | Read-only ClickHouse HTTP authentication                                                                             |
| `BAYN_ALPACA_KEY_ID`, `BAYN_ALPACA_SECRET_KEY`         | Authenticated read of Alpaca's `GET /v2/calendar`                                                                    |
| `BAYN_ALPACA_BASE_URL`                                 | `https://paper-api.alpaca.markets` (default) or `https://api.alpaca.markets`, matching the calendar credential       |

Verify that both lanes were active from before open and have drained through the close, the archive is caught up with
no silent rejects, and no backfill or route change affected the window. Select five **consecutive exchange trading
dates** from the Alpaca calendar, not five civil days; include scheduled early closes and skip weekends and holidays.
After each close and drain, run the verifier and retain its JSON as the gate record. To verify all five dates
after the last one drains, use the following Bash sequence with the dates from your actual qualification window:

```bash
(
  # Example calendar sequence spanning a holiday and an early close. Replace before use.
  dates=(2026-11-23 2026-11-24 2026-11-25 2026-11-27 2026-11-30)
  verifier=services/bayn/tools/verify-sip-vs-iex-shadow.ts
  umask 077
  mkdir -p sip-shadow-reports || exit 1
  for date in "${dates[@]}"; do
    bun "$verifier" --session "$date" --format json > "sip-shadow-reports/$date.json" || exit 1
  done
)
```

Use `--format markdown` instead when you need a human-readable scorecard.
The CLI returns zero for PASS, nonzero with a scorecard for a gate FAIL, and nonzero with no scorecard for a
configuration, session, read, or data-contract failure. Retain the five dates, reports, verifier commit, and
source/lag evidence. Live reads are not a pinned archive snapshot: reruns may see late revisions. Do not treat a
repeated read as a new session or cherry-pick around a failed date. Resolve capture, identity, coverage, latency,
or spread failures and qualify a new consecutive window. Escalate missing or inconsistent IEX evidence rather
than interpreting it as SIP spread compression.

### Exact gate per session

All checks below must pass **on each of the five dates** in `bayn.sip-shadow-parity-report.v1`:

- The sorted, distinct RTH SIP roster observed across bars and quotes hashes to the canonical SHA-256 above,
  and **every** SIP row in the window carries that ID and hash. Missing or unexpected symbols fail the gate.
- **QQQ, SMH, XLK, and SPY** each have at least **99.5%** unique final SIP minute bars: at least 389 of 390
  regular minutes or 209 of 210 early-close minutes.
- The archived SIP quote rows contain **zero crossed quotes**. The Flink writer can reject crosses upstream;
  a zero count here is not proof that there were no rejected quotes before ClickHouse. Retain the reject evidence.
- The **pooled SIP quote** p95 ingest latency is **strictly below 2,000 ms**. Raw bar ingest latency is reported
  separately because the bar timestamp labels the **start** of the minute, before the bar can be published.
- The median eligible SIP spread is **at most 2.0 bp each** for **QQQ, SMH, and XLK**. No eligible quotes is a fail,
  not a zero spread.

The verifier uses `[open, close)` in event time from the provider RTH calendar. A final revision wins its minute
by latest ingest timestamp, then partition and offset. Close divergence pairs only shared symbol/minute slots
and divides the absolute difference by the IEX close. Spreads are `10,000 × (ask − bid) / midpoint`, rounded to
nine decimal places in bps to suppress Float64 cancellation at the threshold. Eligible quotes have two positive
prices and sizes and are uncrossed; locked quotes with both sides present contribute a zero spread. The stale
rate is the fraction of archived quote rows arriving **more than five seconds** after their event timestamp.
This measures delay on received rows, not quote gaps or freshness at a future trading decision. Pooled
percentiles weight individual observations; medians average the middle two values, p75/p95 use nearest rank.

The IEX core currently archives 22 symbols, **not** the full 73 and not XLK. The 73-symbol coverage denominator is
the same for both feeds; missing IEX observations are not counted as zero spread or zero divergence. Use the
separate common-symbol spread pool for like-for-like symbol coverage. It is quote-weighted, not time-matched, and
does not establish available execution prices or a guaranteed fill improvement.

Keep IEX primary if any condition is unverified. With five confirmed passes, review the evidence before a
separate primary-feed change. Require a homogeneous SIP cut with the canonical provenance, verify the live
decision/pricing path after rollout, and keep IEX available for rollback through the reviewed release path. A
parity PASS alone does not enable Wave 9B or grant trading authority.

### Deterministic offline replay

`--fixture` reads a local UTF-8 JSON file of at most 64 MiB with no network or credential use:

```sh
bun services/bayn/tools/verify-sip-vs-iex-shadow.ts \
  --session 2026-11-27 --fixture /path/to/shadow-fixture.json --format json
```

Build the fixture as `{ "session": { "date": "...", "openAt": "...", "closeAt": "..." }, "bars": [], "quotes": [] }`.
Use the provider's UTC RTH bounds for `session`, and rows from the two deduplicated SELECT projections in
[the CLI](../../services/bayn/tools/verify-sip-vs-iex-shadow.ts). Times are UTC strings (up to nine fractional
digits), bar offsets are decimal strings, and prices, sizes, flags, partitions, and versions are JSON numbers.
Empty arrays are allowed but cannot produce a PASS. Fixture replays are for repeatable analysis, not substitutes
for five verified live capture sessions.

Live mode streams full RTH row sets and retains numeric samples for exact percentiles. Run on a host provisioned
for full-session quotes; it refuses more than 500,000 bar rows or 30,000,000 quote rows and times out each archive
read after 20 minutes rather than reporting truncated evidence. Do not put the reader behind a profile or proxy
that silently limits SELECT results. If a limit is exceeded, treat the session as unverified; do not sample or
split it and combine per-slice percentiles.

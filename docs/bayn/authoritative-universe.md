# Bayn authoritative universe

Status: **selected; deployment proof pending**

Last verified: 2026-07-21

## Decision

`equity-infrastructure-v1` contains these executable symbols, in canonical order:

```text
AMD,AVGO,COHR,CRDO,LITE,MRVL,MU,NVDA,WDC
```

The candidate pool was the fixed production websocket universe. Selection used only availability, history, feed, and
capacity facts before any candidate return series was read. `SNDK` is the sole exclusion because it has only 358
adjusted daily sessions; the unchanged research gate requires 252 warm-up sessions plus at least 504 evaluation
sessions.

The procedure is deterministic: admit every common stock in the fixed pool that is active, tradable, supported by
both required feeds, has the required common history, and passes the capacity floor. All nine eligible instruments are
selected, so no performance ranking or tie-breaker exists. There are no leveraged or inverse products. Alpaca's US
equity calendar defines sessions and `adjustment=all` defines corporate-action handling. There is no automatic
substitution; an addition, removal, calendar change, or adjustment change requires a new universe ID, symbol hash, and
qualification record.

The ETF universe from `PROOMPT-392` is abandoned. It was inherited without a selection procedure and is absent from
the websocket subscription. Its image must not be promoted, deployed, or qualified. The runtime composition root
remains on the previously deployed TSMOM implementation until a strategy for `equity-infrastructure-v1` is separately
implemented and precommitted. This containment does not approve TSMOM or its ETF universe.

## Pre-return eligibility evidence

Evidence was read from the configured Alpaca Basic account on 2026-07-21. Delayed consolidated SIP adjusted daily bars
provide history and execution-capacity screening after the account's 15-minute restriction; the live websocket
provides real-time IEX observations. Every selected instrument is active, tradable, and already acknowledged on the
production IEX websocket. The same live asset probe reported every selected symbol as a fractionable, marginable,
shortable US equity; these flags are descriptive eligibility facts, not strategy inputs.

At $1,000,000 simulated capital and a 35% per-symbol cap, the largest planned one-day order is $350,000. The committed
capacity rule limits that amount to 1% of trailing-252-session fifth-percentile consolidated daily dollar volume, so a
symbol must provide at least $35,000,000.

| Symbol | Selected | SIP sessions through 2026-07-20 | First session | SIP p05 daily dollar volume | Reason               |
| ------ | -------- | ------------------------------: | ------------- | --------------------------: | -------------------- |
| AMD    | yes      |                           1,122 | 2022-01-27    |                     $4.909B | Eligible             |
| AVGO   | yes      |                           1,122 | 2022-01-27    |                     $4.418B | Eligible             |
| COHR   | yes      |                           1,122 | 2022-01-27    |                     $261.9M | Eligible             |
| CRDO   | yes      |                           1,122 | 2022-01-27    |                     $384.4M | Eligible             |
| LITE   | yes      |                           1,122 | 2022-01-27    |                     $262.7M | Eligible             |
| MRVL   | yes      |                           1,122 | 2022-01-27    |                     $769.6M | Eligible             |
| MU     | yes      |                           1,122 | 2022-01-27    |                     $1.819B | Eligible             |
| NVDA   | yes      |                           1,122 | 2022-01-27    |                    $22.183B | Eligible             |
| WDC    | yes      |                           1,122 | 2022-01-27    |                     $408.8M | Eligible             |
| SNDK   | no       |                             358 | 2025-02-13    |                      $76.4M | Insufficient history |

All nine selected symbols share the same 1,122 complete sessions and have 870 sessions after the 252-session warm-up,
exceeding the 504-session minimum. No symbol was included or excluded using strategy performance.

Every selected symbol has both the executable and reference role: it must exist in the live producer and the finalized
historical publication, with no reference-only substitute. The following operational exposure labels were committed
without consulting candidate returns and exist only to make concentration visible:

| Symbol | Non-return exposure role          | Decision reason                                      |
| ------ | --------------------------------- | ---------------------------------------------------- |
| AMD    | compute processors                | complete history, supported feeds, capacity pass     |
| AVGO   | networking and custom silicon     | complete history, supported feeds, capacity pass     |
| COHR   | optical components                | complete history, supported feeds, capacity pass     |
| CRDO   | high-speed connectivity silicon   | complete history, supported feeds, capacity pass     |
| LITE   | optical components                | complete history, supported feeds, capacity pass     |
| MRVL   | networking and storage silicon    | complete history, supported feeds, capacity pass     |
| MU     | memory                            | complete history, supported feeds, capacity pass     |
| NVDA   | accelerated compute               | complete history, supported feeds, capacity pass     |
| WDC    | data storage                      | complete history, supported feeds, capacity pass     |
| SNDK   | flash storage                     | excluded: only 358 adjusted daily sessions           |

## Pre-rollout production baseline

Read-only verification at 2026-07-21T09:20:51Z found one healthy websocket pod and one Alpaca connection. Alpaca had
acknowledged the legacy ten-symbol set, including `SNDK`, on trades, quotes, bars, and updated bars. The scheduled V1
Signal publisher was active. Both ClickHouse replicas agreed on two finalized V1 manifests; the latest snapshot
`0e3188062fb6781f9dfdc048b4bfe9846d8f4ce74c5e429e296e3ebcd75e93a5` contains 2,398 sessions and 19,184 bars for
the eight legacy ETFs `DBC,EEM,EFA,GLD,IEF,SPY,TLT,VNQ` through 2026-07-20. Neither producer nor database therefore
matches the selected universe yet.

## Data contract

- `argocd/applications/torghut/clickhouse/bayn-universe-v1-configmap.yaml` is the versioned selection artifact.
- The Git commit containing this document and ConfigMap is the immutable eligibility record. Runtime identity is the
  universe ID plus canonical symbol hash; neither is inferred from a mutable database row.
- The ConfigMap binds universe ID `equity-infrastructure-v1` to canonical symbol hash
  `ddcc8adc04dc29822969cddf02b821ea8110856162cca20a7ff28c1c43263e18`.
- The production websocket remains the live IEX producer. `SYMBOLS` and `SYMBOLS_ALLOWLIST` both reference the exact
  nine-symbol ConfigMap value; a subset, superset, reorder, duplicate, or Jangar override fails startup.
- The Signal publisher uses delayed consolidated SIP and the exact nine-symbol set. A bounded REST backfill supplies
  history that a live websocket cannot provide; daily publications run after the Basic plan's 15-minute delay and use
  the same validation and immutable `snapshot_manifests_v2` finalization path. Every manifest binds the universe ID and
  symbol hash.
- The later Bayn strategy integration must accept only a finalized V2 manifest whose universe ID, symbol hash, feed,
  adjustment, calendar, bounds, and canonical symbols match the compiled strategy. A superset, subset, duplicate,
  mixed feed, or missing session must fail closed. This rollout does not change Bayn's current pinned V1 evidence.
- Historical and live events retain their transport and feed identity. Delayed SIP REST history is not relabeled as
  real-time IEX websocket data.
- Live envelopes preserve provider source, feed, provider event time, ingestion time, and updated-bar corrections.
  Historical reconciliation is the exact replica readback and content-hash check performed before V2 finalization.

The websocket itself is not the current latency bottleneck. A read-only production check at 2026-07-21 08:44 UTC
measured about 32 milliseconds from the latest trade/bar event to Kafka, while the latest selected-symbol rows reached
`ta_microbars` and `ta_signals` 14.2-35.9 seconds after event time. Those derived ClickHouse tables are therefore not
an execution-price source. The first Bayn strategy remains finalized-daily; later order routing must consume a fresh
websocket/Kafka quote or prove a materially tighter downstream bound.

## Alpaca Basic coverage boundary

Live authentication probes confirmed the account can use real-time `iex`, 15-minute-delayed `delayed_sip`, and the
derived `overnight` feed. Real-time `sip` and `boats` authentication are not included. The active production IEX socket
also occupies the account's single connection for that feed. The Basic plan permits 30 equity websocket symbols and
200 historical requests per minute.

The configured paper account's asset responses returned every selected symbol as active, tradable, and fractionable,
but did not expose a non-null `overnight_tradable` field. Overnight eligibility is therefore unproven here and must be
measured by `PROOMPT-396`, not inferred. The free overnight feed provides indicative real-time quotes and latest bars,
but its trades are delayed 15 minutes; delayed BOATS history is available through REST. It may be added for observation
and research, but it cannot become execution-price authority. Real-time consolidated pre-market and after-hours pricing
requires Alpaca Algo Trader Plus. Any extended or overnight order path is a later authority change and must use
supported limit-order semantics; this milestone submits no orders. The external contract is documented in Alpaca's
[market-data plan matrix](https://docs.alpaca.markets/us/docs/about-market-data-api),
[24/5 feed specification](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api), and
[extended-hours order rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca).

## Rollout and proof

1. Merge the versioned ConfigMap, additive schema, websocket wiring, and dormant CronJob and backfill templates.
   Neither writer is rendered, so this phase cannot write Signal data or leave Argo waiting on a suspended CronJob.
2. Promote immutable websocket and publisher images. Promotion pins source revisions and digests but leaves both Signal
   writers inert.
3. Through a reviewed GitOps change, add and start only the one-shot backfill Job while the CronJob remains absent.
   Require it to finalize exactly one SIP/all snapshot for all nine symbols from 2022-01-27 through
   2026-07-20: 1,122 sessions and 10,098 bars.
4. Reproduce the manifest, session, and bar hashes from both ClickHouse replicas and prove one manifest row whose
   universe ID and symbol hash match the ConfigMap.
5. Confirm websocket readiness reports the same universe ID, hash, and exact symbols, and that Alpaca acknowledged all
   nine symbols on trades, quotes, bars, and updated bars.
6. Remove the completed one-shot Job and enable the daily CronJob in one GitOps change. Never render both writers as
   active. Retain two successful scheduled publications before declaring the publication lane stable.

Rollback is fail-closed: suspend the active writer, preserve every finalized or partially staged row, and revert only
after no Job is active. Bayn remains pinned to its existing rejected TSMOM evidence; this data rollout neither deploys
a new strategy nor grants broker or capital authority.

## Read-only ClickHouse proof

After publication, the following aggregate must return nine rows with 1,122 sessions and a common 2022-01-27 through
2026-07-20 range:

```sql
SELECT
  symbol,
  count() AS sessions,
  min(session_date) AS first_session,
  max(session_date) AS last_session
FROM signal.adjusted_daily_bars_v2
WHERE snapshot_id = '<finalized-snapshot-id>'
GROUP BY symbol
ORDER BY symbol;
```

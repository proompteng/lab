# Complete-cut Friday replay

Economic acceptance failed. Profitability remains **UNPROVEN**. All three frozen scenarios completed September 11,
2026, from 13:30 through 20:00 UTC using the unchanged strategy, existing Alpaca IEX data, a simulated IOC broker,
production execution and reconciliation, isolated PostgreSQL, and TigerBeetle. No Alpaca orders were submitted.

| Scenario           |  Latency | Slippage | Displayed liquidity | Fees | Passes / failed | Intents / fills | Net P&L |
| ------------------ | -------: | -------: | ------------------: | ---: | --------------: | --------------: | ------: |
| Baseline           |   100 ms |     1 bp |                100% |   1x |         782 / 0 |           1 / 0 |      $0 |
| Cost stress        |   500 ms |     2 bp |                 50% |   2x |         782 / 0 |           1 / 0 |      $0 |
| Severe cost stress | 1,000 ms |     5 bp |                 25% |   3x |         782 / 0 |           1 / 0 |      $0 |

Each account began and ended with $100,000 cash, no position, no fees, and exact reconciliation. The baseline selected
45 NVDA shares at a $221.73 IOC limit at 14:01:30 UTC. Each order canceled without filling, then the unchanged native
entry lifecycle waited for the close. These results supply no realized returns, fill-cost calibration, or evidence of
profitable capacity. The report does not retain the unsuccessful arrival quote and cannot establish why that IOC did
not fill. Positive fills and crash recovery are covered separately by implementation acceptance tests.

## Independently captured source cuts

The [Kafka receipt](source-topology-receipt.json) records direct ListOffsets reads at both export timestamps plus
retention bounds and high-water marks. All 19 raw partitions are represented: three bars, thirteen quotes, and three
trades. The seven populated quote cuts and all six populated bar/trade cuts exactly match the original export.
Quote partitions 0, 2, 5, 7, 10, and 11 have no records in this interval. Kafka returned no timestamp match at either
boundary; their empty cuts use the observed high-water marks, including nonzero marks for historical partitions 0
and 2. The isolated regenerated rolling-feature stream has one partition covering offsets 0 through 3816.

All three runs admitted and consumed the same 8,437,431 records against this complete 20-cut inventory. Actual
first/last arrivals span the full exchange session. The original bytes are unchanged:
`f631e62244b6fa46f908b08fc7898a3a04f1b816332d454acf323af6709503ba`.
The NDJSON remains in the local retained-source artifact store and is required for reproduction. The earlier
reports and their original incomplete inventory remain available in the [parent evidence directory](../README.md).

The subsequent [source-admission receipt](source-admission-receipt.json) validates and consumes all 8,437,431
records using the independently supplied [capture](independent-capture.json), whose file SHA-256 is
`2c77a11084bacee70a3ebe862477304150e533903725e703f450c0d8838ebd8a`.
The capture is derived directly from the Kafka and Dorvud receipts, separately from the exported NDJSON. The verifier
at `5a2db05ca60e97bdbf3a8f6635b43efc11e973a7` requires both that capture and its separately pinned hash.
This is source-admission evidence for the identical bytes and source manifest used below. It does not rerun execution
or change the original reports, run IDs, or executable provenance. Future session CLI runs bind the capture hash into
the run identity and retain it in their reports.

## Frozen execution and limits

The [study plan](frozen-study-plan.json) and [executable receipt](executable-receipt.json) were recorded before any
v4 execution. Every scenario directly used the same retained bundle, SHA-256
`6ab2e293cb78acfec7fc905e1af8a6d402346f40f9c54e7dbc5e09f114f28a14`, built from
`0d56c6ce8c989d74d9300afab7cc5ab4a5815764`. This is a development-configured local execution; the declared image
digest is unverified. Later settlement-persistence changes are proved by their separate process-kill acceptance,
not by these historical reports.

Raw arrival times retain the later of producer ingestion and Kafka timestamp. Dorvud's regenerated rolling features
use a declared 100 ms delivery model and preserve their actual Saturday computation timestamps. Their coordinates
are simulated. Asset eligibility was observed on Saturday and is explicitly counterfactual. Quote-size units and
IEX execution costs remain uncalibrated. Technical indicators do not change this baseline. No feed upgrade or
strategy tuning was used to obtain these results.

Reports retain independent run IDs, source identity, execution assumptions, broker state, full-session schedules,
accounting counts, exact reconciliation, and independently checked report hashes:

- [Baseline](baseline-report.json)
- [Cost stress](cost-stress-report.json)
- [Severe cost stress](severe-cost-stress-report.json)

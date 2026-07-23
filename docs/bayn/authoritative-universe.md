# Bayn authoritative universe

Status: **precommitted; Signal publication in progress**

## Current contract

Bayn's next qualification candidate uses one fixed, canonically ordered universe:

```text
DBC,EFA,IEF,SPY,VNQ
```

| Field | Value |
| --- | --- |
| Universe ID | `cross-asset-taa-v1` |
| Symbol hash | `c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8` |
| History start | `2016-01-04` |
| Evaluation start | `2017-01-03` |
| Historical feed | delayed consolidated `sip` |
| Adjustment | `all` |
| Calendar | `alpaca-us-equity-calendar-v1` |

The hash is SHA-256 over the exact CSV string above. A reorder, addition, removal, feed change, adjustment change, or
calendar change is a different contract and requires a new candidate.

## Selection rationale

The five unlevered US-listed ETFs provide one executable sleeve for commodities (`DBC`), developed ex-US equities
(`EFA`), intermediate US Treasuries (`IEF`), US equities (`SPY`), and US real estate (`VNQ`). This is the deliberately
small cross-asset opportunity set used to test the already committed risk-balanced trend rule; it is not a portfolio
selected by historical candidate performance.

The opportunity-set design follows the simple diversified asset-class framing in Meb Faber's
[A Quantitative Approach to Tactical Asset Allocation](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461).
The exact Bayn horizons, volatility normalization, symbol cap, and portfolio-volatility target are Bayn's existing
M2.1 rule, not a formula attributed to that paper. The rule and all qualification thresholds remain unchanged for this
candidate.

Before precommit, availability-only checks established that each symbol had daily coverage from `2016-01-04`; no OHLCV
value, return, candidate weight, metric, benchmark, or verdict was inspected to choose the symbols. The subsequent
publication and qualification stages are allowed to fail. Missing symbol-session rows are never dropped or filled.

## Shared production contract

`argocd/applications/torghut/clickhouse/bayn-universe-v2-configmap.yaml` is the single active source for:

- the WebSocket delayed-SIP observation symbols and their universe identity;
- the market-data archive universe identity; and
- the adjusted-daily Signal publisher universe, history start, and feed.

The WebSocket Deployment remains one replica with `Recreate`. Its core IEX topics retain the ten-symbol Torghut trading
universe, while `ALPACA_OBSERVATION_SYMBOLS` binds only the delayed-SIP feed to Bayn's five symbols. The resulting 15
symbol-feed subscriptions remain below the Alpaca Basic limit of 30. The archive and publisher remain the existing
services; Bayn does not gain a data writer. The Signal publisher alone writes the three publication tables and
finalizes a snapshot only after exact readback. Bayn retains explicit `SELECT` grants only.

The scheduled CronJob is removed from rendered GitOps during the universe switch. This prevents it from publishing the
new full-history contract before the bounded backfill has been reviewed. It is restored only after the backfill Job is
complete, its evidence is retained, and that Job has been removed through GitOps.

The first historical publication is a separately reviewed, bounded GitOps Job using the same service account, secrets,
immutable image, and least-privilege ClickHouse principal as the scheduled publisher. It is removed after evidence is
retained. The scheduled publisher must then produce two additional complete snapshots before qualification begins.

## Preserved M2.1 evidence

The prior `equity-infrastructure-v1` contract remains immutable historical evidence even though it is no longer an
active ConfigMap. Production Bayn stays pinned to:

- run `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`;
- snapshot `0945e3331d67437a072d5eb33f65e469b9883a5e762e29e80f7acb389864c79f`;
- qualification result hash `da3f914ae5ea3bf8be8bb08b4b3488b5dfbd04464045f7add8b3d7550c000bf4`; and
- maximum authority `OBSERVE`.

The M2.1 economic gates passed, but its terminal qualification is `REJECTED` for insufficient power and walk-forward
history. Replacing the active ingestion universe does not rewrite that snapshot, PostgreSQL graph, dossier, or
TigerBeetle journal.

## Pre-change live baseline

Read-only verification at `2026-07-23T00:24Z`, before the v2 GitOps change, found:

- Argo applications `torghut` and `bayn` Synced/Healthy at
  `b8bf36d01f31f5352630fc3f9f5d1ec408452016`;
- one ready WebSocket replica on image digest
  `sha256:c5753db003befaa6525469de4bf659bc774c4543531bae2dcd2f145ecb8e608b`;
- the archive job running on image digest
  `sha256:1a3fba53b409b7f1f37d2836c59497a73ed4c6ea244d9004ee3c2dbf945043d4`;
- the scheduled Signal publisher last successful at `2026-07-22T22:30:15Z` on digest
  `sha256:2561a79d2baaa998036344c121cc3986aedec365881911dd592d334163d82729`;
- both ClickHouse replicas agreeing on the pinned M2.1 manifest, 10,116 unique bars, 1,124 unique sessions, and all
  content hashes; and
- Bayn ready with exact 15-account/578-transfer TigerBeetle reconciliation and zero broker events, orders, fills, or
  paper accounting transactions.

## Publication acceptance

For the bounded backfill and two scheduled snapshots, both physical ClickHouse replicas must independently report:

- exactly one V2 manifest with the current universe ID and symbol hash;
- exactly one adjusted daily bar for every symbol and exchange session;
- `bar_count = session_count * 5`;
- no duplicate bar or session keys;
- identical requested bounds, source revision, image digest, ordered bar hash, ordered session hash, and manifest hash;
  and
- publisher grants restricted to the documented `SELECT, INSERT` set while Bayn remains `SELECT`-only.

No candidate returns, weights, metrics, or benchmark comparisons are calculated in this publication ticket. Bayn's
deployment snapshot and qualification pin do not change.

Rollback is fail-closed: stop new publication through GitOps, preserve finalized and partially staged rows for
diagnosis, and revert the shared contract only after no publisher Job is active. Never delete the M2.1 evidence or
Signal publication tables.

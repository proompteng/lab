# Bayn authoritative universe

Status: **precommitted; finalized Signal snapshot accepted; qualification release ready**

## Current contract

Bayn's next qualification candidate uses one fixed, canonically ordered universe:

```text
DBC,EFA,IEF,SPY,VNQ
```

| Field            | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Universe ID      | `cross-asset-taa-v1`                                               |
| Symbol hash      | `c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8` |
| History start    | `2016-01-04`                                                       |
| Evaluation start | `2017-01-03`                                                       |
| Historical feed  | delayed consolidated `sip`                                         |
| Adjustment       | `all`                                                              |
| Calendar         | `alpaca-us-equity-calendar-v1`                                     |

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
- the market-data archive identity for delayed-SIP and overnight observations; and
- the adjusted-daily Signal publisher universe, history start, and feed.

The WebSocket Deployment remains one replica with `Recreate`. Its core IEX topics retain the ten-symbol Torghut trading
universe, while `ALPACA_OBSERVATION_SYMBOLS` binds only the delayed-SIP feed to Bayn's five symbols. The resulting 15
symbol-feed subscriptions remain below the Alpaca Basic limit of 30. The archive selects universe metadata per feed:
the Torghut IEX topic retains its separate `torghut-core-equity-v1` contract, while delayed-SIP and overnight topics use
the exact Bayn contract above. The archive and publisher remain the existing services; Bayn does not gain a data writer.
The Signal publisher alone writes the three publication tables and
finalizes a snapshot only after exact readback. Bayn retains explicit `SELECT` grants only.

The universe switch used one separately reviewed, bounded GitOps backfill Job with the same service account, secrets,
immutable image, and least-privilege ClickHouse principal as the scheduled publisher. The Job completed once, its
evidence was retained, and it was removed through GitOps. The normal publisher CronJob is restored for unattended
operations. Later scheduled publications are operational observations, not a qualification entry gate.

## Preserved M2.1 evidence

The prior `equity-infrastructure-v1` contract remains immutable historical evidence even though it is no longer an
active ConfigMap. Before the explicit M2.2 release, production Bayn was pinned to:

- run `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`;
- snapshot `0945e3331d67437a072d5eb33f65e469b9883a5e762e29e80f7acb389864c79f`;
- qualification result hash `da3f914ae5ea3bf8be8bb08b4b3488b5dfbd04464045f7add8b3d7550c000bf4`; and
- maximum authority `OBSERVE`.

The M2.1 economic gates passed, but its terminal qualification is `REJECTED` for insufficient power and walk-forward
history. The M2.2 one-shot release removes the runtime run-ID pin without rewriting that snapshot, PostgreSQL graph,
ephemeral operator audit output, or TigerBeetle journal. Runtime recovery loads the durable EvidenceStore graph by run
ID; no dossier file is mounted.

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

## Accepted M2.2 snapshot

Read-only verification of finalized snapshot
`840c75885270b349d4a992e003918ce7e6fe39730f981a20b2e88ae2db45a2e2` found that both physical ClickHouse replicas
independently report:

- exactly one V2 manifest with the current universe ID and symbol hash;
- exactly 13,260 adjusted daily bars across 2,652 exchange sessions;
- `bar_count = session_count * 5` with no missing symbol-session keys;
- no duplicate bar or session keys;
- identical requested bounds, source revision, image digest, ordered bar hash, ordered session hash, and manifest hash;
  and
- publisher grants restricted to the documented `SELECT, INSERT` set while Bayn remains `SELECT`-only.

One accepted finalized snapshot with this both-replica integrity proof is sufficient for qualification. No candidate
returns, weights, metrics, or benchmark comparisons were calculated for publication acceptance.

Publication rollback remains fail-closed: stop new publication through GitOps and preserve finalized or partially
staged rows for diagnosis. Never delete M2.1 evidence or Signal publication tables.

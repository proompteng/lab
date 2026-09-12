# Retained Friday native replay

Status: economic acceptance failed; profitability **UNPROVEN**. This is historical simulation evidence, not current
deployment or broker readiness. It uses the existing Alpaca IEX integration without a data-feed upgrade.

The unchanged intraday-momentum baseline completed the September 11, 2026 regular session, 13:30–20:00 UTC. Each
scenario ran the native activation, cycle, decision, planner, risk, coordinator, and reconciliation paths against an
isolated simulated broker, real PostgreSQL, and TigerBeetle. No Alpaca order was submitted.

| Scenario           | Arrival latency | Adverse slippage | Displayed liquidity | Fee multiplier | Polls / failed | Intents / fills | Net P&L |
| ------------------ | --------------: | ---------------: | ------------------: | -------------: | -------------: | --------------: | ------: |
| Baseline           |          100 ms |             1 bp |                100% |             1× |        782 / 0 |           1 / 0 |      $0 |
| Cost stress        |          500 ms |             2 bp |                 50% |             2× |        782 / 0 |           1 / 0 |      $0 |
| Severe cost stress |        1,000 ms |             5 bp |                 25% |             3× |        782 / 0 |           1 / 0 |      $0 |

Each run began and ended with $100,000 cash and no position. At 14:01:30 UTC the strategy selected a buy of 45 NVDA
shares with a $221.73 IOC limit. All three orders canceled without fills. There were no fees or accounting transfers
because no fill occurred. Reconciliation remained exact; an empty reconciled ledger does not demonstrate profitable
execution. The broker report does not retain a no-fill quote or cancellation-reason receipt, so these reports alone
cannot attribute cancellation to a particular arrival quote condition.

The native baseline binds one entry decision and waits for the close even after a benign zero-fill IOC. Consequently
this study has no realized trade returns and cannot estimate win rate, expected trade profit, fill-cost calibration,
or strategy capacity. No entry rule, threshold, or symbol ranking was changed to obtain a fill. Before qualifying the
strategy, its entry lifecycle needs a separate explicit decision about renewed observations after an unfilled attempt;
any changed policy needs a new frozen study and independent subsequent-session evidence.

## Source and timing

The source contains 8,433,614 unchanged raw Kafka records, including 46,448 bars, plus 3,817 rolling features generated
by Dorvud's production transition. Raw exports covered 79 contiguous five-minute cuts. Every raw partition cut contains
each offset between its declared endpoints. Raw availability is the later of rounded-up WebSocket ingestion and Kafka
timestamp, with additional downstream transport assumed zero. Quote-size units retain the existing model's share
interpretation and remain uncalibrated against consolidated liquidity.

The later bootstrap's retained feature partition ordering deferred most candidate features until after Friday's close.
That initial attempt produced no decisions and had ten calendar-discovery failures near the close. This corrected study
regenerated features from raw arrival order, supplied the actual next exchange sessions, and retained the failed attempt
separately. New features become available 100 ms after their triggering raw arrival or completed window, whichever is
later. Their source revisions and actual Saturday computation timestamps remain intact. Feature coordinates and
delivery are explicitly simulated; current asset eligibility was also observed on Saturday and is counterfactual.

The [frozen study plan](frozen-study-plan.json) records all inputs and assumptions before these results. The complete
8,437,431-record NDJSON remains in the local retained-source artifact store under SHA-256
`f631e62244b6fa46f908b08fc7898a3a04f1b816332d454acf323af6709503ba`; it is not included in Git. Reproduction requires
those exact bytes. The [Dorvud receipt](dorvud-generation-receipt.json) binds the extracted raw bars and feature output.

## Execution evidence

The reports bind independent run IDs, source identity, assumptions, full-session schedules, broker state, durable
counts, reconciliation, and report hashes:

- [Baseline report](baseline-report.json)
- [Cost-stress report](cost-stress-report.json)
- [Severe-cost-stress report](severe-cost-stress-report.json)

All three used the development-configured Bayn source at `4b1a044d0fa903771969d469247021d859271a7e`. The
[retained bundle receipt](cost-run-executable-receipt.json) identifies the bundle used directly by both cost runs,
rebuilt from that same commit after the baseline. The baseline's original bundle hash was not retained. The configured
image digest is explicitly unverified input and is not evidence of a deployed-image execution.

Separate native integration and process-kill acceptance exercise positive fills and idempotent accounting. Those tests
establish implementation behavior; they do not substitute for absent trade returns in this retained-session study.

The original study manifest listed only partitions containing exported records. It did not retain empty cuts for
quote partitions 0, 2, 5, 7, 10 and 11. The subsequent admission fix binds replay to the committed 13-partition quote
topology and rejects that incomplete inventory. The archived runs and hashes remain unchanged; their source-completeness
claim is limited to their declared cuts. A new accepted study requires independently captured cuts for every partition,
including evidence for empty cuts, and a newly frozen input. These reports do not establish profitable trading.

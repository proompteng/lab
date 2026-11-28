# Bayn documentation

Start with the [service guide](../../services/bayn/README.md) for current behavior and the
[GitOps guide](../../argocd/applications/bayn/README.md) for declared deployment and authority. Verify the live revision,
account, and reconciliation state before operating. Runbooks and research evidence do not grant trading authority.

## Active Production Runbooks

- [Profitability master playbook](profitability-master-playbook.md) — PAPER qualification, comparisons, and stops.
- [November 30 cutover dossier](monday-2026-11-30-cutover-playbook.md) — read-only opening settlement and F4/O1 shadow evidence.
- [Live profitability audit](live-profitability-audit-runbook.md) — read-only execution and cost checks.
- [Cycle operations](../runbooks/bayn-cycle-operations.md) — diagnose execution and recovery.
- [Consolidated SIP shadow rollout](consolidated-sip-shadow-rollout.md) — parked capture, parity, and rollback; IEX stays primary.
- [ETF Noise Area activation](etf-noise-area-activation.md) and [macro ETF canary rollout](macro-canary-etf-rollout.md) —
  separate reviewed paths for candidates, not active trading authority.
- [Intraday alpha cutover](intraday-alpha-cutover.md) and [v2.1 execution upgrade](intraday-v2-1-execution-upgrade.md) —
  v2 evidence and the separate candidate v2.1 checklist.
- [Equity short cutover](equity-short-cutover.md) and [Jev 1.14 cutover](jev114-box-cutover.md) — retained procedures
  for exact protocol and authority transitions.
- [CNPG backup and restore](cnpg-backup-restore.md) — backup, retention, and recovery verification.

## Active Architecture Docs

- [Durable broker events](durable-broker-event-architecture.md) — trade-update projection and the durable activity cursor.
- [Streaming market data and Flink features](streaming-market-data-design.md) — source and replay contracts;
  see [streaming operations](../../services/bayn/src/market-data/streaming/README.md) for the configured runtime.
- [Market-data archive](market-data-archive.md) — research storage and the separation from trading.
- [Macro ETF core](macro-etf-core-architecture.md) — pure planning module, not a registered strategy.
- [Coordinated macro portfolio v2](macro-portfolio-v2.md) — opt-in F4/O1 sizing, risk controls, and replay protocol.
- [Test-suite audit](test-suite-audit-2026-11-27.md) — skip inventory and the fast and full CI tiers.

## Research Evidence

- [Retained evidence bundles](evidence/) — study reports, frozen receipts, and active replay inputs. Large trial
  outputs and one-off runners pruned from rejected studies remain available at the historical revisions linked in the reports.
- [Prospective registrations](prospective/) and [read-only SQL](sql/) — declared controls and audit queries.
- [Jev study export](study-evidence-export.md) and [migration validation](jev-migration-validation.md) — retained decision
  evidence and qualification rules.
- [Historical intraday v1 replay](intraday-alpha-v1-historical-evidence.md),
  [November 16–20 PAPER economics](session-investigation-2026-11-20.md), and
  [stock-short controls](stock-short-research-2026-11-13.md) — scoped results, not live readiness or strategy approval.

## Incidents

- [Incident records](incidents/) — historical symptoms, impact, and recovery evidence.

## Archive

- [Historical investigations and research](archive/README.md) — dated context and reproducibility notes, not current
  operating procedures.

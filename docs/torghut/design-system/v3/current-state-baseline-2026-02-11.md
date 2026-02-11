# Current State Baseline (2026-02-11)

## Objective
Provide a reproducible factual baseline for Torghut code, runtime health, and data quality before implementing the v3
strategy engine.

## Snapshot Date and Scope
- Snapshot date: `2026-02-11` (UTC).
- Environment: Kubernetes namespaces `torghut` and `agents`.
- Purpose: define constraints and failure modes that v3 must solve.

## Code Baseline

### Trading loop shape
`services/torghut/app/trading/scheduler.py` currently orchestrates a single-cycle flow:
- ingest signals from ClickHouse,
- evaluate strategy decisions,
- apply portfolio sizing,
- optional LLM review,
- execution policy + risk + firewall,
- order submission + reconciliation.

### Decision logic baseline
`services/torghut/app/trading/decisions.py` is strategy-loop capable but signal logic is effectively one hardcoded family:
- buy: `macd > macd_signal` and `rsi < 35`.
- sell: `macd < macd_signal` and `rsi > 65`.

### Feature extraction baseline
`services/torghut/app/trading/features.py` extracts only a small subset:
- MACD, MACD signal, RSI, price, volatility.

This underuses available upstream signal fields and limits strategy diversity.

### Strategy catalog baseline
`services/torghut/app/strategies/catalog.py` supports reload + merge/sync semantics and safe validation for current
schema, but does not yet encode plugin type/version/params contracts.

### Persistence baseline
`services/torghut/app/models/entities.py` provides stable tables for:
- strategies,
- trade decisions,
- executions,
- position snapshots,
- LLM decision reviews,
- ingest cursor.

This is a strong base for extension but lacks research-ledger tables.

## Runtime Baseline (Cluster)

### Health summary
From `kubectl` on `2026-02-11` UTC:
- Knative service `torghut` ready on revision `torghut-00060`.
- Revision `torghut-00059` failed with startup crash loop.
- Flink `torghut-ta` is `RUNNING` and `STABLE`.
- ClickHouse installation `torghut-clickhouse` reported healthy.
- CNPG cluster `torghut-db` healthy.

### Confirmed runtime failure
From `kubectl logs -n torghut deploy/torghut-00059-deployment --all-containers --tail=120`:
- startup settings parse failure due to `LLM_ENABLED='jangar'` (non-boolean).

Implication:
- config type validation must run in CI before Argo rollout.

## Data Baseline

### Postgres (`torghut`)
Observed counts:
- `strategies`: `1`
- `trade_decisions`: `2016`
- `executions`: `342`
- `llm_decision_reviews`: high `error` verdict volume (`8705`) versus `approve` (`575`) and `veto` (`20`)

Implication:
- LLM loop is noisy and must remain non-authoritative.

### ClickHouse (`torghut`)
Observed dataset shape:
- `ta_signals`: `154,822` rows.
- `ta_microbars`: `143,518` rows.
- range approximately `2026-01-12` to `2026-02-10 21:58:45 UTC`.
- top symbols by row count: NVDA, MSFT, MU, TSM, SNDK.

Implication:
- sufficient data exists for richer multi-factor feature contracts.

## Drift and Consistency Findings
- Git manifest `argocd/applications/torghut/strategy-configmap.yaml` symbols differ from sampled live
  `ConfigMap/torghut-strategy-config` content.
- This must be treated as release-blocking until parity checks are automated.

## Baseline Gaps (Severity-Ranked)
1. Strategy extensibility gap:
- no plugin runtime + no strategy type/version contract.
2. Feature parity gap:
- online decision path ignores many available TA fields.
3. Research governance gap:
- no immutable experiment ledger and promotion evidence chain.
4. Config safety gap:
- runtime saw preventable env type failures.
5. LLM stability gap:
- error-heavy LLM review stream needs stronger circuit and promotion gates.

## Required v3 Outcomes Anchored to Baseline
- Introduce pluginized strategy runtime with deterministic contracts.
- Introduce canonical feature schema with online/offline parity checks.
- Add research ledger schema and promotion gates with anti-overfit diagnostics.
- Add CI config schema checks for all Torghut runtime manifests.
- Keep LLM in bounded advisory mode with measurable reliability gates.

## Validation Commands (Baseline Re-check)
```bash
kubectl get ksvc -n torghut
kubectl get flinkdeployment -n torghut
kubectl get clickhouseinstallation -n torghut
kubectl get cluster -n torghut
kubectl logs -n torghut deploy/torghut --tail=200
kubectl get configmap -n torghut torghut-strategy-config -o yaml
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select count(*) from trade_decisions;"
```

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-baseline-audit-v1`.
- Required keys:
  - `torghutNamespace`
  - `agentsNamespace`
  - `gitopsPath`
  - `outputPath`
- Expected execution:
  - collect code pointers and runtime snapshots,
  - compare GitOps config with live config,
  - emit gap-ranked markdown report.
- Expected artifacts:
  - baseline report at `docs/torghut/design-system/v3/current-state-baseline-2026-02-11.md` (or successor date file),
  - machine-readable snapshot JSON under `services/torghut/artifacts/baseline/<timestamp>.json`.
- Exit criteria:
  - all severity-ranked gaps mapped to an owning v3 doc and implementation lane.

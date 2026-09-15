# Priority 7: Fully Autonomous Quant + LLM Torghut System (Novel Alpha Design)

## Status

- Version: `v5-full-autonomy-novel-alpha`
- Date: `2026-02-21`
- Maturity: `draft design`
- Scope: end-to-end autonomous research, strategy generation, deployment, execution, and self-improvement

## Intent

Define a full-autonomy Torghut design where the system can:

1. discover new ideas,
2. design and test strategies,
3. promote candidates through staged capital ramps,
4. execute and monitor live positions,
5. adapt itself continuously without manual intervention during normal operation.

This document describes an experimental architecture for a novel alpha hypothesis that is not broadly disclosed in
public materials from major quant firms.

## Novel Alpha Hypothesis

Alpha source is not a single model. It is a closed-loop **self-evolving market cognition system** with three coupled edges:

- `E1: Counterfactual Market Worlds`
  - generate synthetic but realism-constrained market futures to stress-test policy choices before live action.
- `E2: Reflexive Multi-Agent Debate`
  - use role-specialized LLM agents that argue, critique, and adversarially challenge each trade hypothesis.
- `E3: Causal Regime Reallocation`
  - dynamically shift strategy/risk budgets based on causal attribution of recent PnL drivers, not just correlations.

The alpha claim is that continuously integrating `E1 + E2 + E3` creates compounding decision quality that static
research-release cycles cannot match.

## Core Principles

- fully autonomous by default after policy bootstrap.
- deterministic machine policy remains final authority over capital/risk movement.
- every decision path must be replayable from immutable artifacts.
- system must degrade safely to lower-autonomy modes under uncertainty spikes.

## Autonomy Model

### Autonomy Levels

- `L0 supervised`: human approvals required at every promotion stage.
- `L1 guarded autonomy`: machine proposals + human promotion confirmation.
- `L2 full autonomy`: machine promotion allowed when all gates pass and risk budget is within envelope.

Target state in this design:

- operate at `L2` in paper and constrained-live profiles,
- auto-degrade to `L1` or `L0` if risk/quality SLOs break.

### Autonomy Domain Coverage

- research: autonomous
- engineering: autonomous (code + tests + validation)
- deployment: autonomous (GitOps commits + rollout policies)
- trading decisions: autonomous
- incident response: autonomous first response + optional operator escalation

## End-to-End Autonomous Loop

| Loop Stage   | Function                                                  | Primary Components                               | Output                        |
| ------------ | --------------------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| `F0 sense`   | ingest multi-modal market + research signals              | data plane, news/RAG, alt data adapters          | unified feature/state tensor  |
| `F1 imagine` | generate counterfactual scenarios and policy outcomes     | world-model simulator + execution realism models | scenario frontier set         |
| `F2 debate`  | multi-agent thesis/risk/execution argumentation           | LLM committee + critic agents                    | structured decision slate     |
| `F3 decide`  | deterministic policy gate + portfolio optimization        | risk engine + allocation optimizer               | executable intent             |
| `F4 act`     | route and execute orders with inventory/latency awareness | execution microservices                          | fills + telemetry             |
| `F5 learn`   | causal attribution, regret analysis, strategy mutation    | learning engine + registry                       | updated priors/policies       |
| `F6 govern`  | audit, compliance, retention, and auto-rollback checks    | governance engine                                | promotion/rollback directives |

## System Architecture

### 1) Perception Layer

- market microstructure feed handlers (quotes, trades, book states, flow imbalance).
- macro/regime signals (rates, vol term structure, correlation stress).
- textual and event streams (news, filings, structured calendar events).
- research intake stream (new papers, methods, benchmarks).

### 2) World-Model Layer

- probabilistic time-series foundation model router.
- microstructure simulator calibrated to realized execution behavior.
- counterfactual generator constrained by historical regime priors and market impact realism.

### 3) Cognitive Layer (LLM Multi-Agent)

- `thesis_agent`: proposes opportunity hypothesis.
- `risk_agent`: attacks tail scenarios and hidden fragility.
- `execution_agent`: evaluates implementability and cost.
- `policy_judge`: validates schema and policy constraints.
- `red_team_agent`: adversarially probes for failure modes and overfitting signals.

### 4) Decision Layer

- deterministic gate stack (`data -> stats -> execution -> policy -> capacity -> compliance`).
- portfolio allocator with regime-aware risk budgeting.
- confidence-aware abstain/escalate semantics.

### 5) Actuation Layer

- broker abstraction + idempotent order lifecycle.
- latency-aware slicing and participation caps.
- real-time kill-switch hooks and circuit breakers.

### 6) Learning Layer

- online and batch learning lanes with model/version registry.
- causal contribution analysis by feature family and agent role.
- mutation engine for strategy variants with automatic rejection of unstable mutants.

## Autonomous Engineering Subsystem

### Workflow

1. pull highest-ranked hypothesis from backlog.
2. generate `StrategyRFC`, plugin code, tests, and migration/config updates.
3. run validation suite (backtest, walk-forward, stress, execution simulation).
4. if gates pass, auto-open PR and auto-merge under policy.
5. trigger GitOps promotion to paper/shadow/constrained-live.

### Safety Constraints

- all generated code must map to approved component boundaries.
- no direct secret scope expansion by autonomous code changes.
- CI failure or missing evidence forces automatic rollback of candidate branch.

## Policy and Risk Engine (Machine-Enforced)

### Hard Limits

- max daily drawdown budget,
- max symbol and sector concentration,
- max latency and slippage thresholds,
- max model uncertainty by strategy class,
- max capital ramp step per promotion window.

### Dynamic Limits

- shrink risk budgets under regime-fragility signals,
- cap participation under liquidity deterioration,
- switch to conservative strategy subset during abnormal volatility states.

### Autonomous Promotion Rule

Machine can self-promote only if:

1. all deterministic gates pass,
2. reproducibility hash bundle is complete,
3. paper/shadow SLO windows are satisfied,
4. rollback rehearsal for target stage is green,
5. risk budget headroom remains above configured threshold.

## Numeric Gate Thresholds (Initial Draft)

These are draft `v0` numeric thresholds for design iteration. They are intentionally conservative and should be tuned
per market and strategy family.

| Gate                      | Metric                               | Threshold                                      | Fail Action                             |
| ------------------------- | ------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| `G1 data-integrity`       | market feed freshness                | p99 age <= `2s` during market hours            | halt new decisions for affected symbols |
| `G1 data-integrity`       | missing feature ratio                | <= `0.5%` per 5-minute window                  | degrade to reduced-feature strategy set |
| `G1 data-integrity`       | schema validation errors             | `0` tolerated in live stages                   | immediate fail-closed + alert           |
| `G2 reproducibility`      | artifact completeness                | `100%` required (model/data/policy hashes)     | block promotion                         |
| `G2 reproducibility`      | replay decision divergence           | <= `0.5%` of decisions for same input hash     | block promotion + open incident         |
| `G2 reproducibility`      | replay pnl drift                     | <= `2 bps` daily equivalent                    | block promotion                         |
| `G3 statistical-validity` | deflated Sharpe (OOS)                | >= `0.8`                                       | reject candidate                        |
| `G3 statistical-validity` | max drawdown vs benchmark            | not worse than benchmark by > `15%` relative   | reject candidate                        |
| `G3 statistical-validity` | regime coverage                      | >= `4` distinct regimes with non-zero exposure | keep in paper only                      |
| `G4 execution-realism`    | realized vs simulated slippage error | p95 abs error <= `3 bps`                       | stop ramp and recalibrate               |
| `G4 execution-realism`    | fill ratio                           | >= `85%` for intended participation bands      | cap participation + hold stage          |
| `G4 execution-realism`    | participation cap utilization        | <= `70%` of configured cap                     | hold stage                              |
| `G5 policy-and-risk`      | intraday 99% VaR                     | <= `0.80%` NAV                                 | shrink risk budget immediately          |
| `G5 policy-and-risk`      | expected shortfall (97.5%)           | <= `1.20%` NAV                                 | shrink risk budget + degrade autonomy   |
| `G5 policy-and-risk`      | single-name gross exposure           | <= `5.0%` NAV                                  | force rebalance                         |
| `G5 policy-and-risk`      | sector gross exposure                | <= `25.0%` NAV                                 | force rebalance                         |
| `G6 paper-window`         | minimum window length                | >= `20` trading days                           | hold in paper                           |
| `G6 paper-window`         | severity-1 safety incidents          | `0`                                            | block promotion                         |
| `G6 paper-window`         | uncertainty calibration error        | <= `0.08` ECE equivalent                       | block promotion                         |
| `G7 live-ramp`            | minimum stage duration               | >= `10` trading days per stage                 | hold stage                              |
| `G7 live-ramp`            | live vs paper slippage drift         | <= `2 bps` p95                                 | rollback one stage                      |
| `G7 live-ramp`            | stage max drawdown breach            | `0` breaches above stage budget                | rollback one stage                      |

### Asset-Class Threshold Profiles (Initial Defaults)

Use these as profile overrides on top of the global gate thresholds.

| Metric                          | Equities (Large Cap) | Futures (Liquid Index/Rates) | Crypto (Top Tier Spot/Perp) |
| ------------------------------- | -------------------- | ---------------------------- | --------------------------- |
| `G1` market feed freshness p99  | <= `2s`              | <= `1s`                      | <= `3s`                     |
| `G1` missing feature ratio (5m) | <= `0.5%`            | <= `0.3%`                    | <= `0.8%`                   |
| `G4` slippage error p95         | <= `3 bps`           | <= `2 bps`                   | <= `6 bps`                  |
| `G4` max participation cap      | <= `3.5%` ADV        | <= `4.0%` ADV-equivalent     | <= `2.0%` venue volume      |
| `G5` intraday 99% VaR           | <= `0.80%` NAV       | <= `0.70%` NAV               | <= `1.20%` NAV              |
| `G6` paper-window minimum       | `20` trading days    | `25` trading days            | `30` calendar days          |
| `G7` live stage minimum         | `10` trading days    | `15` trading days            | `20` calendar days          |

Profile selection rule:

1. determine strategy primary asset class at candidate registration time,
2. apply that class profile to gate evaluator config,
3. if mixed-asset strategy, use the strictest threshold per metric.

## Initial Capital and Risk Envelope (Per Stage)

All values are maximums. Lower policy limits may be applied dynamically.

| Stage                   | Real Capital Usage          | Max Gross Exposure              | Max Single-Name  | Max Participation Rate | Daily Drawdown Stop |
| ----------------------- | --------------------------- | ------------------------------- | ---------------- | ---------------------- | ------------------- |
| `A paper full-autonomy` | `0%` (synthetic only)       | `200%` synthetic NAV-equivalent | `2.0%` synthetic | `2.0%` simulated       | `N/A` (paper)       |
| `B shadow`              | `0%` (parallel intent only) | `100%` shadow NAV-equivalent    | `1.0%` shadow    | `1.0%` shadow          | `N/A` (shadow)      |
| `C constrained-live-1`  | `0.25%` NAV                 | `0.75%` NAV                     | `0.05%` NAV      | `0.25%` ADV            | `5 bps` NAV         |
| `C constrained-live-2`  | `1.00%` NAV                 | `3.00%` NAV                     | `0.20%` NAV      | `0.75%` ADV            | `12 bps` NAV        |
| `D scaled-live-1`       | `3.00%` NAV                 | `9.00%` NAV                     | `0.60%` NAV      | `1.50%` ADV            | `25 bps` NAV        |
| `D scaled-live-2`       | `7.00%` NAV                 | `20.00%` NAV                    | `1.20%` NAV      | `2.50%` ADV            | `40 bps` NAV        |
| `D scaled-live-3`       | `12.00%` NAV                | `30.00%` NAV                    | `2.00%` NAV      | `3.50%` ADV            | `60 bps` NAV        |

Stage advancement requires:

1. all `G1-G7` gate thresholds pass for the stage window,
2. no unresolved severity-1 incidents,
3. successful rollback rehearsal in the current stage.

## Compliance and Operator Override Policy

### Compliance Baseline (Always-On)

- pre-trade checks: restricted symbols, venue constraints, position/exposure limits, and notional caps.
- post-trade checks: execution surveillance, abnormal activity detection, and audit-log completeness.
- immutable audit bundle for every decision and order action with retention clock.
- policy version pinning: each decision references explicit policy checksum and model lineage.

### Operator Override Types

- `OVR-STOP` (hard kill):
  - immediate cancel/close posture and autonomy downgrade to `L0`.
- `OVR-DEGRADE` (autonomy reduction):
  - `L2 -> L1` or `L1 -> L0` without stopping all execution.
- `OVR-HOLD-RAMP` (promotion freeze):
  - prevent stage advancement while allowing current-stage operation.
- `OVR-RESUME` (controlled recovery):
  - restore prior autonomy level only after incident checklist passes.

### Override Governance Rules

- every override requires `override_token` with:
  - issuer ID,
  - reason code,
  - scope (`symbol`, `strategy`, or `global`),
  - expiry timestamp.
- `OVR-RESUME` requires two-person approval when prior incident severity >= 1.
- any active override blocks autonomous stage promotion.
- expired overrides are automatically revoked and logged.

## Conflict Resolution Order (Gate Results vs Overrides)

When gate outcomes and override states disagree, apply this deterministic precedence order:

1. `OVR-STOP` always wins:
   - force safe halt and autonomy `L0`.
2. hard integrity/compliance failures win next:
   - any `G1` schema failure or compliance deny forces fail-closed regardless of `OVR-RESUME`.
3. unresolved severity-1 gate failure wins over any non-stop override:
   - no promotion, no autonomy increase.
4. `OVR-DEGRADE` wins over pass outcomes:
   - reduce autonomy level even if all gates pass.
5. `OVR-HOLD-RAMP` wins over promotion eligibility:
   - keep current stage; allow execution only if no blocking gate failure exists.
6. `OVR-RESUME` is evaluated last:
   - can restore prior autonomy only if no blocking conditions remain.

Tie-break rule:

- if state is ambiguous or evaluator versions disagree, choose safest action: `block + degrade autonomy one level`.

State-transition guardrails:

- autonomy can increase by at most one level per successful stage window.
- after any severity-1 event, minimum recovery path is `L2 -> L1`, never direct `L0 -> L2`.
- stage promotion and autonomy increase cannot occur in the same control cycle.

## Canonical JSON Schemas (v0)

### `gate-evidence.json`

```json
{
  "$schema_version": "torghut.gate_evidence.v0",
  "run_id": "uuid",
  "candidate_id": "string",
  "stage": "paper|shadow|constrained_live_1|constrained_live_2|scaled_live_1|scaled_live_2|scaled_live_3",
  "policy_checksum": "sha256:...",
  "asset_profile": "equities|futures|crypto|mixed",
  "generated_at": "2026-02-21T00:00:00Z",
  "window": {
    "start": "2026-02-01T00:00:00Z",
    "end": "2026-02-21T00:00:00Z"
  },
  "gates": {
    "G1": {
      "status": "pass|fail",
      "metrics": {
        "feed_freshness_p99_s": 0.0,
        "missing_feature_ratio": 0.0,
        "schema_errors": 0
      },
      "thresholds": {
        "feed_freshness_p99_s_max": 2.0,
        "missing_feature_ratio_max": 0.005,
        "schema_errors_max": 0
      },
      "reason_codes": ["string"]
    },
    "G2": {
      "status": "pass|fail",
      "metrics": {
        "artifact_completeness": 1.0,
        "replay_divergence_ratio": 0.0,
        "replay_pnl_drift_bps": 0.0
      },
      "thresholds": {
        "artifact_completeness_min": 1.0,
        "replay_divergence_ratio_max": 0.005,
        "replay_pnl_drift_bps_max": 2.0
      },
      "reason_codes": ["string"]
    },
    "G3": {
      "status": "pass|fail",
      "metrics": {
        "deflated_sharpe_oos": 0.0,
        "max_drawdown_rel_vs_benchmark": 0.0,
        "regime_coverage_count": 0
      },
      "thresholds": {
        "deflated_sharpe_oos_min": 0.8,
        "max_drawdown_rel_vs_benchmark_max": 0.15,
        "regime_coverage_count_min": 4
      },
      "reason_codes": ["string"]
    },
    "G4": {
      "status": "pass|fail",
      "metrics": {
        "slippage_error_p95_bps": 0.0,
        "fill_ratio": 0.0,
        "participation_utilization": 0.0
      },
      "thresholds": {
        "slippage_error_p95_bps_max": 3.0,
        "fill_ratio_min": 0.85,
        "participation_utilization_max": 0.7
      },
      "reason_codes": ["string"]
    },
    "G5": {
      "status": "pass|fail",
      "metrics": {
        "intraday_var_99_nav": 0.0,
        "expected_shortfall_975_nav": 0.0,
        "single_name_gross_nav": 0.0,
        "sector_gross_nav": 0.0
      },
      "thresholds": {
        "intraday_var_99_nav_max": 0.008,
        "expected_shortfall_975_nav_max": 0.012,
        "single_name_gross_nav_max": 0.05,
        "sector_gross_nav_max": 0.25
      },
      "reason_codes": ["string"]
    },
    "G6": {
      "status": "pass|fail",
      "metrics": {
        "paper_window_trading_days": 0,
        "sev1_safety_incidents": 0,
        "uncertainty_calibration_error": 0.0
      },
      "thresholds": {
        "paper_window_trading_days_min": 20,
        "sev1_safety_incidents_max": 0,
        "uncertainty_calibration_error_max": 0.08
      },
      "reason_codes": ["string"]
    },
    "G7": {
      "status": "pass|fail",
      "metrics": {
        "stage_duration_trading_days": 0,
        "live_vs_paper_slippage_drift_p95_bps": 0.0,
        "stage_drawdown_breach_count": 0
      },
      "thresholds": {
        "stage_duration_trading_days_min": 10,
        "live_vs_paper_slippage_drift_p95_bps_max": 2.0,
        "stage_drawdown_breach_count_max": 0
      },
      "reason_codes": ["string"]
    }
  },
  "overall": {
    "eligible_for_promotion": false,
    "blocking_reasons": ["string"],
    "recommended_action": "hold|degrade|rollback|promote"
  }
}
```

### `override-token.json`

```json
{
  "$schema_version": "torghut.override_token.v0",
  "override_id": "uuid",
  "token_type": "OVR-STOP|OVR-DEGRADE|OVR-HOLD-RAMP|OVR-RESUME",
  "issuer": {
    "user_id": "string",
    "role": "oncall|risk_officer|compliance|sre"
  },
  "reason_code": "string",
  "scope": {
    "mode": "global|strategy|symbol",
    "strategy_id": "optional-string",
    "symbol": "optional-string"
  },
  "requested_autonomy_target": "L0|L1|L2",
  "issued_at": "2026-02-21T00:00:00Z",
  "expires_at": "2026-02-21T06:00:00Z",
  "approval": {
    "required_approvers": 1,
    "approver_ids": ["string"]
  },
  "state": "active|expired|revoked|consumed",
  "signature": {
    "algo": "ed25519",
    "key_id": "string",
    "sig": "base64"
  }
}
```

## Data and Artifact Contracts

### Core Entities

- `market_state_snapshots`
- `counterfactual_scenarios`
- `agent_deliberations`
- `decision_intents`
- `execution_outcomes`
- `learning_updates`
- `promotion_audits`

### Mandatory Metadata

- model IDs + versions + calibration set refs,
- dataset snapshots and feature schema hash,
- policy checksum,
- run ID and lineage graph,
- decision rationale + critic dissent fields.

## SLOs and Control Metrics

- decision-to-execution p95 latency.
- uncertainty calibration error by regime bucket.
- adverse-selection rate and slippage drift.
- autonomous rollback trigger rate.
- strategy mutation success-to-reject ratio.
- gate determinism (same inputs -> same gate output).
- live safety incidents per million decisions.

## Failure Modes and Autonomous Response

### Hallucinated or weak reasoning in cognitive layer

- response: critic consensus threshold increase + policy_judge strict mode + forced abstain.

### Regime discontinuity breaks learned priors

- response: immediate capital contraction, scenario expansion, and fallback strategy set.

### Silent data corruption

- response: integrity mismatch detector halts affected symbols and replays last known good state.

### Positive-feedback overtrading loop

- response: turnover governor clamps strategy activations and requires cooldown windows.

## Autonomous Red-Team Test Matrix

| Test Case                         | Injection Method                                                   | Pass Criteria                                       | Fail Response                 | Cadence       |
| --------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------- | ------------- |
| hallucinated catalyst             | inject synthetic unsupported news claim into context               | `policy_judge` veto and no live order generated     | force `L1`, raise incident    | weekly        |
| prompt-injection in external text | embed adversarial instructions in RAG payload                      | instruction ignored; deterministic policy unchanged | tighten retrieval allow-list  | weekly        |
| stale-data decision attempt       | delay market feed beyond freshness threshold                       | decision path fail-closed within `2s`               | symbol halt + replay          | daily         |
| schema-drift corruption           | alter feature schema mid-run                                       | schema gate rejects and blocks decisions            | freeze candidate + alert      | daily         |
| replay nondeterminism             | rerun identical input/hash bundle                                  | decision divergence <= `0.5%`                       | block promotion               | per release   |
| simulator gaming                  | optimize to simulator artifact with poor live realism              | `G4` rejects due to slippage/fill drift             | hold ramp + recalibrate       | per candidate |
| committee collusion               | bias all agent roles toward approve verdict                        | critic dissent requirement triggers abstain/veto    | increase critic quorum        | weekly        |
| execution venue outage            | simulate partial exchange/broker outage                            | auto failover or safe halt within `5s`              | global `OVR-HOLD-RAMP`        | monthly       |
| risk engine partial failure       | disable one risk check module in test harness                      | watchdog detects and blocks order routing           | `OVR-STOP` automatic          | weekly        |
| autonomous code regression        | generate patch that passes unit tests but fails risk scenario test | promotion blocked by validation suite               | revert candidate branch       | per candidate |
| compliance-rule mismatch          | run strategy against updated restricted list snapshot              | order prevented and audit reason emitted            | immediate compliance incident | daily         |
| kill-switch latency breach        | saturate control plane during stop command                         | all open orders cancelled/blocked within `3s`       | escalate severity-1           | monthly       |

Minimum red-team bar before stage promotion:

1. all tests in required cadence window are green,
2. no unresolved severity-1 red-team failures,
3. trend of critical failure count is non-increasing over last 4 windows.

## ImplementationSpec Catalog (Full Autonomy Track)

### `torghut-v5-full-autonomy-loop-v1`

Purpose:

- run full `F0-F6` loop for a bounded universe and risk envelope.

Required keys:

- `universe`
- `autonomyLevel`
- `riskBudgetProfile`
- `policyConfigPath`
- `artifactPath`

### `torghut-v5-counterfactual-worlds-v1`

Purpose:

- generate and score counterfactual scenario frontier for decision pre-check.

Required keys:

- `worldModelRef`
- `scenarioCount`
- `realismConstraintsPath`
- `artifactPath`

### `torghut-v5-autonomous-engineering-v1`

Purpose:

- synthesize and validate code changes from approved hypotheses.

Required keys:

- `repository`
- `base`
- `head`
- `hypothesisRef`
- `validationConfigPath`
- `artifactPath`

### `torghut-v5-autonomous-promotion-v1`

Purpose:

- evaluate machine promotion eligibility and execute staged ramp.

Required keys:

- `candidateRef`
- `promotionStage`
- `gateConfigPath`
- `riskEnvelopePath`
- `artifactPath`

## Rollout Strategy

1. Stage A (`paper full-autonomy`)
   - run complete autonomous loop in paper with full artifact capture.
2. Stage B (`shadow + constrained-live`)
   - enable machine promotion with strict capital caps and short review windows.
3. Stage C (`scaled-live autonomy`)
   - increase risk envelope only after sustained SLO stability and low rollback rate.
4. Stage D (`multi-strategy federation`)
   - expand to multiple strategy families with global capital governor.

## What Makes This Distinct

- strategy decisions are generated through **counterfactual simulation + adversarial LLM debate + causal allocation**
  in a single closed loop.
- engineering and deployment are part of the same autonomous control system, not separate manual pipelines.
- governance is encoded as machine-verifiable contracts, allowing autonomy without removing deterministic safety.

## Exit Criteria (Design Complete)

- all loop stages (`F0-F6`) have explicit contracts and failure responses.
- autonomous promotion path includes deterministic stop conditions.
- replay framework can reproduce any live decision and promotion event.
- documented downgrade path from `L2 -> L1 -> L0` is operationally testable.

## References

- `docs/torghut/design-system/v5/07-autonomous-research-to-engineering-pipeline.md`
- `docs/torghut/design-system/v5/08-leading-quant-firms-public-research-and-systems-2026-02-21.md`
- `docs/torghut/design-system/v5/06-whitepaper-technique-synthesis.md`

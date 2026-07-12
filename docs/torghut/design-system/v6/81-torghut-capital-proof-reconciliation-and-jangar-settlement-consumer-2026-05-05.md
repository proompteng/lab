# 81. Torghut Capital Proof Reconciliation and Jangar Settlement Consumer (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: Jangar has route/API integration and many control-plane modules; historical Swarm prose is not a one-to-one runtime spec.
- Matched implementation area: Jangar/control-plane integration.
- Current source evidence:
  - `services/jangar/src/routes/ready.tsx`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
  - `services/jangar/src/server/control-plane-source-serving-contract-verdict.ts`
  - `services/jangar/src/routes/api/torghut/trading/control-plane/quant/snapshot.ts`
  - `argocd/applications/agents/kustomization.yaml`
- Design drift note: Verify against current Jangar modules/routes before treating design contracts as live behavior.


## Decision

Torghut should add a **Capital Proof Reconciliation** contract that consumes Jangar's Evidence Settlement Authority
before treating any live-submission liveness as promotable capital authority. The trading service may continue to run
and collect evidence, but non-shadow capital must require a fresh Jangar settlement with `external_capital` allowed and
fresh Torghut profit clocks for the exact lane and hypothesis.

The reason is plain in the May 5 evidence:

- `GET /healthz` returned `{"status":"ok","service":"torghut"}`;
- `GET /db-check` returned `ok=true`, current head `0029_whitepaper_embedding_dimension_4096`, and
  `schema_graph_lineage_ready=true`;
- `GET /trading/health` reported Postgres, ClickHouse, and Alpaca healthy, and `live_submission_gate.capital_stage`
  was `live`;
- `GET /trading/status` reported `live_submission_gate.allowed=true`, but `shadow_first.capital_stage="shadow"`,
  `promotion_eligible_total=0`, `rollback_required_total=3`, and `dependency_quorum.decision="block"`;
- the same status payload showed signal lag around 2941 seconds, `signal_continuity.alert_active=true`, and stale
  empirical jobs for benchmark parity, foundation-router parity, and Janus evidence;
- Jangar market-context health for `AAPL` returned `overallState="degraded"` with stale technicals, fundamentals,
  news, and regime domains.

The current service is useful and should stay up. The unsafe part is letting a live submission gate or broker health
look like capital promotion authority when the profitability and Jangar dependency clocks are held.

## Problem

Torghut has three different capital stories at the same time:

1. service liveness and broker connectivity say the system can submit;
2. shadow-first and hypothesis readiness say no current hypothesis is promotable;
3. Jangar dependency quorum and market-context clocks say upstream authority is blocked or stale.

This is not a database schema problem. Schema is current. The problem is reconciliation: capital gates need one answer
that compares liveness, profitability, freshness, rollback readiness, and Jangar settlement using the same clock ids.

## Options Considered

### Option A: Keep Current Live Submission Gate Semantics

Leave `live_submission_gate.allowed` as the primary live-capital signal and rely on downstream humans to read the
alpha-readiness and dependency-quorum fields.

Pros:

- zero implementation cost;
- preserves existing status route compatibility;
- keeps live-capable service operation simple.

Cons:

- makes `allowed=true` easy to misread as promotion authority;
- does not bind capital decisions to Jangar settlement receipts;
- allows stale empirical jobs and stale market context to become advisory rather than veto-capable;
- spreads interpretation across dashboards, operators, and future automation.

Decision: reject.

### Option B: Fail Torghut Readiness When Profit Clocks Are Held

Make `/healthz`, `/readyz`, or `/trading/health` fail when no hypothesis is promotion eligible or Jangar dependency
quorum is blocked.

Pros:

- hard to miss;
- reduces green-surface ambiguity.

Cons:

- removes the service path needed to collect repair evidence;
- conflates liveness with capital promotion;
- can force Knative rollout churn during market-data or empirical-proof outages;
- still does not define how Jangar settlement ids are consumed.

Decision: reject. Torghut should keep serving and observing while capital is held.

### Option C: Reconcile Capital Proofs Against Jangar Settlement

Add a `capital_proof_reconciliation` section to Torghut status surfaces. It consumes Jangar settlement, Torghut
hypothesis proof, empirical jobs, market context, signal continuity, rollback readiness, and live-submission liveness.
It returns one capital decision and one list of held reasons.

Pros:

- preserves service availability and evidence collection;
- turns stale empirical and market-context evidence into scoped capital holds;
- makes Jangar settlement a typed dependency instead of an informational string;
- gives Jangar deployers one Torghut field to check before external capital gates.

Cons:

- requires route compatibility work and tests across existing health/status payloads;
- requires a clear migration period because `live_submission_gate.allowed` already exists;
- requires careful naming so "live-capable" and "capital-promotable" remain separate.

Decision: select Option C.

## Chosen Architecture

### CapitalProofReconciliation

Add a new status object to Torghut routes:

```text
capital_proof_reconciliation
  reconciliation_id
  generated_at
  jangar_settlement_ref
  decision                      # allow, observe_only, shadow_only, hold, unknown
  allowed_capital_classes       # observe, shadow, paper, live_canary, live_scale
  live_submission_liveness
  hypothesis_profit_clock
  empirical_job_clock
  market_context_clock
  signal_continuity_clock
  rollback_clock
  broker_clock
  schema_clock
  negative_evidence_refs
  repair_hints
```

The field is additive. Existing fields remain, but any operator or automation that asks "may capital move?" must use
`capital_proof_reconciliation.decision`, not `live_submission_gate.allowed`.

### Jangar Settlement Consumer

Torghut must consume Jangar's settlement authority with these rules:

- missing Jangar settlement means `decision="hold"` for non-shadow capital;
- Jangar settlement without `external_capital` means `shadow_only`;
- Jangar settlement with stale `data_proof_clock`, `execution_clock`, or `route_probe_clock` means `shadow_only`;
- only a fresh settlement with `external_capital` can unlock `paper`, `live_canary`, or `live_scale`, and only if
  Torghut's own clocks also pass.

### Profit and Freshness Clocks

Torghut clocks required for non-shadow capital:

- `hypothesis_profit_clock`: at least one hypothesis is promotion eligible and no active hypothesis requires rollback;
- `empirical_job_clock`: required empirical jobs are fresh and promotion-authority eligible;
- `market_context_clock`: required domains are fresh for the lane, or the lane explicitly does not require them;
- `signal_continuity_clock`: signal lag is below the lane threshold and no continuity alert is active;
- `rollback_clock`: emergency stop is inactive and rollback dry-run evidence is fresh for live classes;
- `schema_clock`: `/db-check` is current and schema lineage warnings are non-blocking by policy;
- `broker_clock`: broker and account are live only for capital classes that require broker access.

## Status Route Contract

Expose `capital_proof_reconciliation` in:

- `/trading/status`;
- `/trading/health`;
- `/trading/profitability/runtime`;
- Jangar quant health proxy responses that summarize Torghut capital state.

The object must include a compact `negative_evidence_refs` list. It must not include full raw logs, credentials,
account secrets, or unbounded route payloads.

## Implementation Scope

Engineer stage should implement:

1. a pure reconciliation builder in `services/torghut/app/trading/`;
2. a Jangar settlement client with bounded timeout and cached-last-proof semantics;
3. status-route additions that keep existing fields backward compatible;
4. metric counters for `capital_reconciliation_decision_total` and `capital_reconciliation_hold_reason_total`;
5. tests that prove live submission liveness is not capital promotion authority.

Jangar integration should:

1. expose the Jangar `authority_id` and allowed action classes to Torghut;
2. include Torghut's reconciliation decision in the Jangar control-plane status dependency quorum;
3. block Jangar `external_capital` when Torghut reports `shadow_only`, `hold`, or `unknown`.

## Validation Gates

The implementation PR is not ready unless these tests pass:

- `/trading/status` includes `capital_proof_reconciliation` while keeping existing `live_submission_gate` fields.
- `live_submission_gate.allowed=true` plus `promotion_eligible_total=0` produces `shadow_only` or `hold`.
- Jangar settlement missing produces a non-shadow capital hold.
- Stale empirical jobs produce a non-shadow capital hold and cite job ids compactly.
- Stale market context holds only lanes that require market context.
- Schema current plus lineage warnings remains allowed for observe/shadow when warnings are policy-accepted.
- Rollback required on any active hypothesis blocks live canary and live scale.
- Jangar status proxy reports the same reconciliation id as Torghut.

## Rollout

Roll out in four phases:

1. Shadow: emit `capital_proof_reconciliation` without changing live submission behavior.
2. Operator parity: update dashboards and Jangar status to show reconciliation decision next to live submission.
3. Jangar enforcement: Jangar `external_capital` requires Torghut reconciliation not to be held.
4. Torghut enforcement: non-shadow capital classes require both Jangar `external_capital` and Torghut local clocks.

## Rollback

Rollback should preserve visibility:

- disable enforcement but continue emitting reconciliation decisions;
- keep `live_submission_gate` unchanged for backward compatibility;
- if the Jangar settlement client fails, cache the last proof for observation but hold non-shadow capital when the
  proof expires;
- if status route payload size grows too much, keep only ids, decisions, reason codes, and repair hints.

## Risks and Open Decisions

- Jangar settlement freshness must be short enough to prevent stale capital approval but long enough to survive small
  network blips.
- The first implementation should not attempt to solve portfolio optimization. It should reconcile authority only.
- Broker liveness should not bypass missing profit evidence.
- Market-context requirements must remain lane-scoped so options or non-news lanes are not blocked by irrelevant stale
  domains.
- The UI must label `live_submission_gate` as liveness and `capital_proof_reconciliation` as authority.

## Handoff

Engineer acceptance gates:

- the reconciliation builder is pure and covered with fixture tests;
- all named Torghut status routes emit the same `reconciliation_id`;
- missing or held Jangar settlement blocks non-shadow capital;
- no existing route consumers lose fields during the additive rollout;
- metrics expose decisions and hold reasons.

Deployer acceptance gates:

- shadow reconciliation runs through at least one market session before enforcement;
- Jangar and Torghut show the same Jangar settlement id and Torghut reconciliation id;
- non-shadow capital remains held while `promotion_eligible_total=0` or `rollback_required_total>0`;
- rollback can disable enforcement without hiding the reconciliation payload;
- NATS handoff messages cite the reconciliation id, capital decision, and smallest proof to refresh.

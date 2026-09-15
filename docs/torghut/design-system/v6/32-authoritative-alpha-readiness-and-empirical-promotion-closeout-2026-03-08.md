# 32. Authoritative Alpha Readiness and Empirical Promotion Closeout (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `next-iteration design + live-state recommendation`
- Scope: `services/torghut/**`, `services/jangar/**`, `argocd/applications/torghut/**`, `docs/agents/designs/**`,
  live Torghut/agents clusters, and Torghut Postgres promotion evidence tables
- Primary objective: define the highest-priority next build slice after the March 7 proving lane closeout
- Current live state: simulation/runtime is healthy, but autonomous readiness and empirical promotion are still not
  authoritative enough for robust capital governance
- Source-state update (`2026-03-09`): the repo now contains heartbeat-backed dependency quorum behavior, empirical
  manifest validation, workflow-result RBAC, persisted empirical job rows, persisted `vnext_promotion_decisions`, and
  operator status endpoints; the remaining stale recommendation is to keep funding already-landed control-plane slices
  instead of finishing authoritative empirical evidence generation and recurring prove-and-promote automation.

## Executive Summary

The next highest-priority build is not "enable simulation". That slice is already materially working.

Live state on `2026-03-08` shows:

- `torghut` and `torghut-sim` are both `Ready=True`.
- recent full-session simulation evidence is consistent with a healthy simulation/runtime lane.
- `torghut /trading/health` still reports `alpha_readiness.dependency_quorum.decision=block`.
- the current block reasons are `agents_controller_unavailable` and `workflow_runtime_unavailable`.
- recent `torghut-empirical-promotion-*` workflows are not yet deterministic: some succeeded, while others failed on
  workflow result/RBAC or manifest contract issues.

The next build slice therefore needs to close the gap between:

1. a runtime that can trade and simulate, and
2. a promotion/admission system that can tell the truth about whether that runtime is actually promotable.

The correct recommendation is:

- make dependency truth authoritative,
- make empirical promotion deterministic,
- make the promotion ledger repeatedly exercised and operator-readable,
- only then resume broader autonomy or strategy/model expansion.

## Implementation update (2026-03-09)

The March 8 live-cluster findings remain useful as a snapshot, but the source tree has moved ahead of this recommendation.

The following slices are now materially implemented in code:

- heartbeat-backed Jangar control-plane authority and fail-closed `unknown` handling for missing authoritative rows;
- empirical manifest normalization/validation before promotion processing;
- `workflowtaskresults` RBAC for the Torghut runtime service account;
- persisted `vnext_empirical_job_runs` freshness rows and `/trading/empirical-jobs` status surfacing;
- persisted `VNextPromotionDecision` rows and `/trading/completion/doc29` gate surfacing.

The remaining highest-priority gap is therefore narrower and more specific than this doc originally states:

1. replace deterministic scaffold evidence for benchmark parity, foundation-router parity, and Janus-Q with replay- or
   live-window-derived empirical artifacts that can actually carry promotion authority;
2. add recurring prove-and-promote automation so those artifacts are generated and exercised across repeated sessions
   instead of one-off manual submissions;
3. keep broader autonomy, new alpha branches, and model-family expansion behind those empirical-authority gates.

## Assessment Basis

### Live cluster evidence

- `kubectl get ksvc -n torghut torghut torghut-sim -o wide`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health | jq`
- `kubectl get workflow -n torghut | rg 'empirical|sim|NAME'`
- `kubectl logs -n torghut pod/torghut-empirical-promotion-d6jsk --all-containers --tail=120`
- `kubectl get deploy -n agents agents agents-controllers agents-alloy -o wide`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq`

### Source evidence

- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/config.py`
- `services/jangar/src/server/control-plane-status.ts`
- `services/torghut/scripts/run_empirical_promotion_jobs.py`
- `argocd/applications/torghut/knative-service.yaml`
- `docs/agents/designs/jangar-authoritative-controller-heartbeat-and-dependency-quorum-2026-03-08.md`

### Database evidence

- `kubectl exec -n torghut torghut-db-1 -- psql -U postgres -d torghut -Atc "<counts query>"`
- `kubectl exec -n torghut torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "<latest rows query>"`

## Verified Current State

### 1. Simulation/runtime is healthy enough to stop treating "enable sim" as the top blocker

The current cluster does not look like a system blocked on simulation enablement:

- `torghut` is serving and ready.
- `torghut-sim` is serving and ready.
- `torghut-ta-sim`, `torghut-forecast-sim`, and related sim-side pods are up.
- recent full-session replay evidence has already proven that the mirrored environment can run end to end.

That means the user's statement that a full-day simulation completed successfully on `2026-03-08` is directionally
consistent with the current runtime surface.

### 2. Autonomous readiness still blocks on non-authoritative dependency truth

`services/torghut/app/trading/hypotheses.py` loads Jangar dependency quorum from
`TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`.

Current Torghut config still points that at:

- `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`

The live problem is that this status surface is not authoritative for the actual `agents` control plane.

Observed on `2026-03-08`:

- the `agents-controllers` deployment in namespace `agents` is healthy and running the controller workload;
- the status payload served from the current Jangar URL reports `agents-controller`, `supporting-controller`, and
  `orchestration-controller` as `disabled`;
- `torghut /trading/health` therefore blocks capital readiness on reasons that reflect the wrong serving topology, not
  the actual controller state.

This is more serious than a cosmetic health bug. It means the system can produce a truthful-looking readiness verdict
from a non-authoritative source.

### 3. Empirical promotion is present, but not yet deterministic enough to serve as promotion authority

Recent workflow evidence shows mixed results:

- some `torghut-empirical-promotion-*` workflows succeeded;
- others failed with `workflowtaskresults.argoproj.io is forbidden`;
- others failed because `run_empirical_promotion_jobs.py` rejected the manifest with
  `RuntimeError: manifest must be a mapping`.

This means the empirical-promotion lane is real, but it is still too brittle to be treated as a dependable promotion
gate.

### 4. The durable evidence plane exists, but the vNext promotion ledger is still thin

Observed live row counts from Torghut Postgres on `2026-03-08`:

- `research_runs`: `1576`
- `research_candidates`: `322`
- `research_promotions`: `325`
- `vnext_promotion_decisions`: `1`
- `vnext_empirical_job_runs`: `8`
- `llm_dspy_workflow_artifacts`: `1`
- `lean_canary_incidents`: `0`

Recent rows reinforce the same shape:

- `research_candidates` are mostly `challenger / evaluated / paper`;
- recent `research_promotions` are denying promotion rather than advancing it;
- the single `vnext_promotion_decisions` row is also `deny`;
- the single DSPy workflow artifact recommends `hold`.

This is not a data-empty system. It is a system whose newer promotion authority is still too sparsely exercised to be
trusted as a mature operating loop.

## Chosen Recommendation

The updated recommendation iteration is:

1. make empirical promotion authoritative,
2. make prove-and-promote execution recurring,
3. make promotion authority repeated and inspectable,
4. keep broader autonomy/model expansion behind those gates.

This is the shortest credible path from "simulation/proof works" to "autonomous promotion can be trusted" without
re-funding already-landed control-plane work.

## What Needs To Be Built

### Slice 1. Authoritative empirical promotion evidence

Empirical promotion still needs to become authoritative, not merely durable.

Required changes:

- replace deterministic scaffold outputs for benchmark parity, foundation-router parity, and Janus-Q with artifacts
  derived from replayed or observed windows;
- keep manifest validation and persistence fail-closed, but promote only from empirical lineage with non-placeholder
  authority contracts;
- treat partially written or non-authoritative empirical artifacts as ineligible, never ambiguous.

### Slice 2. Recurring prove-and-promote automation

The control plane is present, but the operating loop is still too manual.

Required changes:

- add a recurring trading-day planner/orchestrator that runs historical simulation, empirical promotion, and
  readiness verification as one repeatable flow;
- remove the current dependence on ad hoc Argo submissions for repeated proving sessions;
- materialize a day-run registry so repeated exercises are inspectable without reconstructing workflow history by hand.

### Slice 3. Promotion ledger maturity

The vNext ledger needs to be exercised enough that operators can trust it.

Required changes:

- write successful empirical runs into `vnext_empirical_job_runs` consistently;
- materialize promotion-denial reasons into durable decision rows;
- attach enough operator-friendly metadata that a candidate can be traced without reconstructing the entire artifact
  bundle by hand;
- keep old artifact tables as evidence inputs, but make decision authority clearly legible in the new ledger.

### Slice 4. Resume criteria for broader autonomy

Do not re-enable broader autonomous promotion, additional swarms, or new alpha branches until:

- empirical-promotion success is routine rather than occasional;
- the vNext decision tables show repeated successful writes over multiple sessions;
- operators can explain any deny/block outcome from status plus DB rows, without log archaeology.
- promotion-authority artifacts are empirical rather than deterministic scaffold output.

## Alternatives Considered

- Alternative A: prioritize more strategies/models first.
  - Pros: increases research breadth.
  - Cons: amplifies failure modes on top of an untrustworthy promotion plane.
- Alternative B: focus only on simulation throughput.
  - Pros: simpler and already productive.
  - Cons: leaves the autonomous capital/readiness story unresolved.
- Alternative C: resume swarms now that the `agents` queue is clear.
  - Pros: restores automation quickly.
  - Cons: reintroduces load before readiness and promotion truth are fixed.
- Alternative D: chosen approach, fix truth/evidence authority first.
  - Pros: directly addresses the current live failure boundary and preserves simulation gains.
  - Cons: less flashy than strategy expansion and requires cross-service work.

## Risks

- The system may appear slower to "improve" because more work goes into evidence authority than strategy count.
- Tightening promotion contracts may temporarily increase denial rates before the evidence lane stabilizes.
- If the authoritative status slice is implemented incorrectly, it can create a different class of false green or false
  block; topology metadata and freshness semantics must therefore remain explicit.

## Exit Gates

This recommendation iteration is complete only when all of the following are true:

1. `/trading/health` reports dependency quorum from an authoritative source and no longer blocks on false
   `agents_controller_unavailable` / `workflow_runtime_unavailable` signals caused by split deployment topology.
2. A sequence of empirical-promotion workflows completes without manifest or workflow-result contract failures.
3. `vnext_empirical_job_runs` and `vnext_promotion_decisions` contain repeated recent rows from successful production
   exercises, not only singleton or deny-only state.
4. Operators can determine candidate state, evidence freshness, and promotion outcome directly from status plus durable
   DB rows.

## Recommendation To Engineers

If only one implementation wave can be funded next, it should be:

1. authoritative empirical promotion evidence generation,
2. recurring prove-and-promote automation,
3. durable promotion ledger surfacing.

That is the highest-leverage path from a working simulation lane to a robust autonomous trading system.

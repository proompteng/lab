# 99. Torghut Hypothesis Repair Council and Evidence Credit Ladder (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Decision

Torghut should implement a **HypothesisRepairCouncil** that turns stale proof and rejected decisions into ranked
zero-notional repairs, then publishes the repair dividends that Jangar can spend through the evidence credit ladder.

The current trading posture is safe but unprofitable. Sim trading is alive in paper mode, but all three hypotheses are
shadow or blocked, zero are promotion eligible, all three require rollback, required empirical jobs are missing, signal
lag is far beyond the 90-second entry contracts, account-scoped quant health is empty, and live routes time out or
return 502. The right next step is not live capital. The right next step is to price repairs so the system knows which
evidence gap has the highest expected value.

The tradeoff is more rigor before more autonomy. Torghut will do fewer repairs, but each repair must declare the
hypothesis it benefits, the proof debt it reduces, and the capital gate it might make decidable.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster Evidence

- Live `torghut-00224` and sim `torghut-sim-00305` pods were `2/2 Running`; the earlier sim image-pull failure had
  cleared.
- Torghut events still showed liveness and readiness probe timeouts on the live pod, repeated ClickHouse
  multiple-PDB warnings, and keeper PDB warnings.
- Only one Torghut job was visible: `torghut-empirical-artifacts-retention`, completed about 18 hours earlier. No fresh
  empirical repair job was active.
- Direct CNPG exec and workflow listing were forbidden to the runtime service account. Profit repair proof must be
  route-level and least-privilege.

### Data Evidence

- `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with no missing or
  unexpected heads and lineage ready.
- Live `/healthz` returned HTTP 200 after about 6.5 seconds, while live `/readyz`, `/trading/health`, and
  `/trading/status` timed out after ten seconds. Live `/trading/empirical-jobs` returned HTTP 502 through the service
  path.
- Sim `/readyz`, `/trading/health`, and `/trading/status` returned HTTP 200 in paper mode. They are useful proof
  surfaces, not capital clearance.
- Sim status showed three hypotheses, one blocked and two shadow, zero promotion eligible, and three rollback required.
- The hypothesis reasons included Jangar dependency block, signal lag, missing feature rows, missing drift checks,
  required feature set unavailable, and market context staleness.
- `/trading/empirical-jobs` reported required jobs missing:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Account-scoped Jangar quant health for `TORGHUT_SIM` returned zero latest metrics, no stages, and
  `quant_latest_metrics_empty`, even though the unscoped aggregate quant health had current metrics.
- Options catalog `/readyz` returned ready but carried `last_success_ts=null` and a timeout detail. That is a proof
  quality issue.

### Source And Test Evidence

- `services/torghut/app/trading/empirical_jobs.py` already knows whether empirical jobs are missing, stale, truthful,
  and promotion-authority eligible.
- `services/torghut/app/trading/hypotheses.py` already expresses hypothesis state, promotion eligibility, rollback
  requirement, feature dependencies, and observed blockers.
- `services/torghut/app/trading/submission_council.py` already treats empirical jobs, Jangar dependency quorum, and
  quant health as capital blockers.
- `services/torghut/app/main.py` is too broad to be the only repair authority. The repair council should compile from
  existing helpers and expose a compact route.
- Existing tests cover empirical jobs, submission council gates, hypothesis governance, DB checks, trading health, and
  quant evidence behavior. Missing coverage is repair scoring across multiple hypotheses and proof debts.

## Problem

Torghut knows why capital is blocked, but it does not rank the repairs by expected value.

That leaves the system with safe stagnation:

- empirical jobs are missing, so promotion cannot be trusted;
- signal lag makes shadow hypotheses non-actionable;
- rejected-decision attribution is not turning into strategy retirement or data repair;
- quant health is present only in an aggregate view, not in the account-scoped proof used by submission gates;
- options readiness can say ready while the last useful success timestamp is null.

Each issue can be repaired, but they should not all receive equal capacity. The highest-value repair is the one that
turns the next capital gate from unknown into measurable, while staying zero-notional.

## Alternatives Considered

### Option A: Refresh Every Missing Empirical Job First

Run all four empirical jobs before doing any other repair.

Pros:

- Directly addresses a hard promotion blocker.
- Uses existing empirical job contracts.
- Easy to verify when complete.

Cons:

- Ignores signal lag and rejected-decision causes.
- Can spend scarce launch capacity during rollout debt.
- May refresh proof for hypotheses that should be retired.

Decision: keep as a candidate, not the architecture.

### Option B: Repair The Live Route Timeouts First

Optimize `/trading/status`, `/readyz`, and `/trading/health` until live service reads are consistently fast.

Pros:

- Improves operator visibility.
- Reduces Jangar consumer timeouts.
- Likely lowers readiness probe noise.

Cons:

- Does not prove any hypothesis is profitable.
- Can make broken proof easier to fetch without making it fresher.
- Does not rank empirical, quant, options, and signal repairs.

Decision: necessary platform work, insufficient for profitability.

### Option C: Hypothesis Repair Council

Compile all current proof debts into repair candidates, score them by expected information value and capital-gate
impact, and expose the result as repair dividends for Jangar credits.

Pros:

- Turns blocked capital into a ranked zero-notional repair queue.
- Keeps capital fail-closed while allowing measurable progress.
- Lets Jangar throttle repair capacity without guessing trading value.
- Produces explicit hypotheses and guardrails for engineer and deployer stages.

Cons:

- Requires a scoring model and fixtures.
- Needs conservative defaults when evidence is incomplete.
- Adds one more route and schema to maintain.

Decision: select Option C.

## Architecture

### Route

Add:

```text
GET /trading/control-plane/hypothesis-repair-council
```

The route returns:

```text
hypothesis_repair_council
  schema_version
  generated_at
  fresh_until
  active_revision
  data_schema
  hypothesis_posture
  repair_candidates
  capital_reentry_guard
  evidence_credit_request
  source_refs
```

The route never submits orders, launches jobs, or mutates database records.

### Repair Candidate

```text
repair_candidate
  candidate_id
  hypothesis_ids
  repair_class
  target_debt
  expected_information_value
  expected_profit_value_bps
  expected_risk_reduction
  required_jangar_credit
  max_runtime
  max_parallelism
  success_gate
  rollback_gate
  evidence_refs
```

`expected_profit_value_bps` is a ranking signal, not a profit promise. It is capped at zero when the repair cannot make
a capital gate more decidable.

### Required Initial Candidates

1. `empirical_jobs_restore_required_set_v1`
   - Repairs missing `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
   - Success gate: all four jobs fresh, truthful, persisted, and tied to current dataset and runtime refs.
   - Capital effect: may unlock paper-capital evaluation, never live capital.

2. `account_scoped_quant_health_v1`
   - Repairs `TORGHUT_SIM` and paper/live account quant health mismatch.
   - Success gate: account-scoped latest metrics non-empty, stages present, freshness window satisfied, and submission
     council consuming the scoped URL.
   - Capital effect: prerequisite for paper and live.

3. `signal_lag_recovery_v1`
   - Repairs hypothesis entry contract breach where observed signal lag is far above 90 seconds.
   - Success gate: lag below contract for two consecutive windows or hypothesis explicitly retired.
   - Capital effect: no capital without empirical proof and Jangar quorum.

4. `rejection_attribution_v1`
   - Repairs rejected decision opacity for the current continuation, microstructure, and reversion lanes.
   - Success gate: every recent rejection has a typed blocker reason and owner repair class.
   - Capital effect: can demote or retire a hypothesis; cannot promote by itself.

5. `options_proof_timestamp_v1`
   - Repairs options catalog ready state without a current success timestamp.
   - Success gate: non-null success timestamp, no current timeout detail, and proof sample refs.
   - Capital effect: only applies to hypotheses that declare options proof as in scope.

## Measurable Trading Hypotheses

- Empirical restore will reduce `missing_jobs` to zero and change empirical authority from blocked to measurable within
  one repair window.
- Account-scoped quant health will eliminate `quant_latest_metrics_empty` for the target account before any paper
  capital evaluation.
- Signal-lag recovery will reduce actionable lag below the hypothesis entry contract or retire the hypothesis from the
  candidate set.
- Rejection attribution will reduce unknown blocker count to zero and identify whether the current strategies need data
  repair, policy repair, or retirement.
- Options proof repair will convert ready-with-null-success into a useful proof timestamp or remove options proof from
  affected hypotheses.

## Capital Reentry Guard

Capital remains blocked unless all of these are true:

- Jangar credit for `paper_capital` or `live_capital` is fresh and `allow`;
- empirical required jobs are fresh and truthful;
- account-scoped quant health is fresh;
- signal lag satisfies each hypothesis entry contract;
- rejected-decision blockers are typed and not unresolved critical blockers;
- options proof is healthy or explicitly out of scope;
- paper-capital gates pass before any live-capital gate.

`live_capital` is never delayed. It is `allow` or `block`.

## Implementation Scope

Engineer stage should add:

- a repair council compiler that consumes empirical jobs, hypothesis summaries, quant health, signal continuity, options
  proof, and rejection telemetry;
- a compact FastAPI route for the council payload;
- deterministic scoring fixtures for the five candidate classes;
- tests proving repair candidates cannot grant capital without Jangar credits and fresh proof;
- source refs that make each candidate reproducible from existing routes.

## Validation Gates

- Unit tests for candidate scoring and capital guard refusal.
- Route contract tests for missing empirical jobs, empty account-scoped quant health, high signal lag, rejected
  decisions, and options ready-with-null-success.
- Integration-style test that simulates a fresh Jangar `zero_notional_repair` credit and proves only repair candidates
  become eligible.
- Manual read-only validation against `/db-check`, `/trading/empirical-jobs`, `/trading/status`,
  `/trading/health`, options `/readyz`, and Jangar account-scoped quant health.

## Rollout

1. Ship the council route in shadow mode with no job launch integration.
2. Compare council ranking against one full market-session and swarm cadence.
3. Let Jangar consume only the top candidate id and required credit class.
4. Enable zero-notional repair launch only when the matching Jangar credit is fresh.
5. Keep paper and live capital blocked until all capital reentry guard conditions pass.

## Rollback

Disable the council route from Jangar consumption and keep existing Torghut submission council gates in force. Because
the route is read-only, rollback does not require database changes. If scoring produces unsafe rankings, return an
empty candidate set with `capital_reentry_guard=block` until the scoring fix is merged.

## Risks

- The first scoring model may overvalue stale empirical repair and undervalue route latency repair. Mitigation: cap
  expected profit value when a repair cannot make a capital gate decidable.
- Account-scoped quant health can disagree with aggregate quant health. Mitigation: capital uses account-scoped proof
  only.
- Repairs may become busywork if success gates are weak. Mitigation: every candidate needs a success gate, rollback
  gate, source refs, and a Jangar credit class.
- The broad `main.py` route surface increases implementation risk. Mitigation: compile the council from existing
  helpers and keep the new route compact.

## Handoff To Engineer And Deployer

Engineer acceptance gate: the route must rank the five current repair candidates, keep all capital blocked, and expose
source refs for the stale or missing proof that each candidate repairs.

Deployer acceptance gate: after rollout, a read-only route check must show repair candidates only when Jangar
zero-notional repair credit is enough to spend, while paper and live capital remain blocked until empirical, quant,
signal, rejection, options, and Jangar credit gates are all fresh.

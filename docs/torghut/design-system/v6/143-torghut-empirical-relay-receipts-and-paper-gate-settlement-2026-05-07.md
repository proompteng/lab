# 143. Torghut Empirical Relay Receipts And Paper Gate Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut empirical relay receipts, doc29 paper gate settlement, TCA and execution proof, scoped quant freshness,
capital warrants, validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`

Extends:

- `142-torghut-alpha-truth-windows-and-capital-reentry-warrants-2026-05-07.md`
- `123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md`
- `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
- `29-code-investigated-vnext-architecture-reset-2026-03-06.md`

## Decision

Torghut will publish **empirical relay receipts** that separate empirical-job truth from paper-gate settlement.

The current Torghut runtime is not starved for empirical-job rows. It is alive on revision `torghut-00252`;
`/healthz` is ok; `/db-check` reports schema current; `/trading/status` and `/trading/autonomy` both report
`empirical_jobs.ready=true`, `status=healthy`, and `authority=empirical`. The satisfied doc29 gate is exactly the
empirical job persistence gate.

The current runtime is also not ready for paper or live capital. Doc29 still has `2` stale and `6` blocked gates.
`paper_gate_satisfied` is blocked by `missing_full_day_simulation_trace`. The 72-hour runtime profitability window has
`25` decisions, `0` executions, and `0` TCA samples. Historical TCA is stale from `2026-04-02T20:59:45Z`, average
absolute slippage is about `568.61bps`, and expected-shortfall coverage is `0`. The proof floor is `repair_only`,
capital remains `zero_notional`, and live submission is closed by `simple_submit_disabled`.

The selected design makes Torghut emit a compact relay receipt that Jangar can consume without guessing what a green
empirical route means. The receipt says: empirical jobs are current or not current; this is the candidate and dataset
they prove; these are the doc29, TCA, scoped quant, execution, and submission gates that still hold paper/live; this is
the zero-notional repair ladder that can close the next blocker.

The tradeoff is stricter paper admission after the Jangar source-binding fix. I accept that. Profitability improves
when we spend the next repair cycle on full-day execution-funnel proof, current TCA, and scoped quant freshness instead
of letting a fixed route config turn into paper authority.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database rows, broker state, Torghut jobs, trading
flags, or empirical artifacts.

### Cluster Evidence

- `kubectl get pods,deploy,job,cronjob,svc -n torghut -o wide` showed the current live revision
  `torghut-00252-deployment` and sim revision `torghut-sim-00352-deployment` both `1/1` available.
- Live and sim Torghut, options catalog, options enricher, ClickHouse, Keeper, Postgres, TA, TA sim, websockets,
  guardrail exporters, Alloy, and Symphony workloads were running.
- The current Torghut image digest for live/sim/options catalog/options enricher was `11ad110644f9...`.
- Recent events showed `torghut-db-migrations`, `torghut-empirical-jobs-backfill`, `torghut-whitepapers-bootstrap`,
  and `torghut-whitepaper-semantic-backfill` completed during the current rollout window.
- Recent events also showed transient Knative readiness/startup failures during revision replacement, repeated
  ClickHouse overlapping PodDisruptionBudget warnings, and a `torghut-keeper` PDB with no matching pods.
- The runtime service account cannot exec into Torghut Postgres. Normal capital proof must therefore come from
  service-owned routes, not privileged SQL.

### Route And Data Evidence

- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true` and `schema_current=true`.
- `/trading/status` returned `mode=live`, `running=true`, `last_run_at=2026-05-07T09:25:17Z`, and
  `last_decision_at=2026-05-06T17:44:19Z`.
- The live submission gate returned `allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`,
  `configured_live_promotion=false`, and `promotion_eligible_total=0`.
- The proof floor returned `floor_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- The proof floor empirical dimension was `pass` with candidate
  `chip-paper-microbar-composite@execution-proof` and dataset `torghut-chip-full-day-20260505-5e447b6d-r1`.
- The proof floor quant-ingestion dimension was informationally degraded with account `PA3SX7FYNUTF`, window `15m`,
  and max stage lag around `56,418s`.
- `/trading/profitability/runtime` returned schema `torghut.runtime-profitability.v1` and a 72-hour window with
  `decision_count=25`, `execution_count=0`, and `tca_sample_count=0`.
- `/trading/tca?limit=5` returned `order_count=13775`, average absolute slippage about `568.61bps`,
  expected-shortfall coverage `0`, and last computation at `2026-04-02T20:59:45.136640+00:00`.
- `/trading/completion/doc29` returned `total=9`, `satisfied=1`, `stale=2`, and `blocked=6`.
- The satisfied doc29 gate was `empirical_jobs_persisted`; `paper_gate_satisfied` remained blocked by
  `missing_full_day_simulation_trace`.
- `/trading/status` and `/trading/autonomy` both included `empirical_jobs.ready=true`, `status=healthy`,
  `authority=empirical`, and `message="empirical jobs fresh"`.

### Source Evidence

- `services/torghut/app/main.py` already composes `/trading/status`, `/trading/autonomy`, `/trading/empirical-jobs`,
  `/trading/completion/doc29`, `/trading/profitability/runtime`, `/trading/tca`, and `/db-check`.
- `services/torghut/app/trading/empirical_jobs.py` records job truthfulness, freshness, promotion authority, candidate
  ids, dataset snapshot refs, artifact refs, and row ids.
- `services/torghut/app/trading/completion.py` derives doc29 gate state and already separates
  `empirical_jobs_persisted` from `paper_gate_satisfied`.
- `services/torghut/app/trading/proof_floor.py` already separates empirical pass from TCA stale, alpha readiness, quant
  ingestion, and submission gate blockers.
- `services/torghut/app/trading/submission_council.py` keeps live submission closed when promotion and empirical
  readiness do not satisfy the live policy.

## Problem

Torghut can prove that empirical jobs are fresh, but it does not yet package that fact as a relay receipt with paper
gate parity.

That distinction matters because a Jangar source-binding bug made empirical jobs look disabled from the Agents
control-plane. Fixing that bug should remove a false source gap. It should not promote capital. Torghut must give
Jangar a receipt that says which proof family is current and which downstream capital gates remain closed.

The current state has a clean split:

- Empirical jobs are fresh and authoritative.
- Doc29 paper gate is not satisfied.
- Full-day simulation evidence is missing.
- Execution and TCA are not current in the 72-hour profitability window.
- Scoped quant ingestion is stale enough to be informationally degraded.
- Live submission is disabled and capital is shadow-only.

If Torghut exports only "empirical jobs healthy", downstream systems will over-read the signal. If it exports only
"proof floor repair_only", downstream systems will under-use the fresh empirical jobs. The receipt needs both.

## Alternatives Considered

### Option A: Treat Healthy Empirical Jobs As Paper-Eligible

Pros:

- Fastest path to paper observations.
- Uses fresh candidate and dataset evidence before it ages.
- Makes the repaired source binding visibly useful.

Cons:

- Ignores doc29 paper gate state.
- Ignores zero executions and zero TCA samples in the current runtime window.
- Ignores stale historical TCA and missing expected-shortfall coverage.
- Ignores scoped quant lag and closed live submission.

Decision: reject.

### Option B: Keep Capital Frozen Until Every Gate Is Manual-Go

Pros:

- Very conservative.
- Avoids ambiguous route interpretation.
- Keeps live notional at zero.

Cons:

- Gives no priority order for repairs.
- Wastes the fresh empirical-job fact instead of using it to narrow the next proof gap.
- Keeps Jangar and Torghut coupled through human interpretation instead of receipts.

Decision: reject.

### Option C: Empirical Relay Receipts With Paper Gate Settlement

This option emits a receipt that marks empirical jobs current while declaring paper and live ineligible until downstream
settlement gates close.

Pros:

- Lets Jangar clear false source-binding debt without clearing capital debt.
- Makes the next repair ladder explicit and zero-notional.
- Uses existing doc29, proof-floor, TCA, and runtime-profitability routes.
- Preserves Torghut ownership of profit semantics and Jangar ownership of action authority.

Cons:

- Requires one more receipt schema and route contract.
- Requires deployers to validate both "empirical current" and "paper still held" after the source fix.
- Requires threshold tuning by hypothesis family.

Decision: select.

## Receipt Contract

Torghut should expose an `empirical_relay_receipt` object from `/trading/status` and `/trading/autonomy`.

Fields:

- `receipt_id`: deterministic hash of Torghut revision, account, candidate id, dataset ref, empirical job row ids,
  doc29 summary, TCA summary, and proof-floor generation time.
- `schema_version`: `torghut.empirical-relay-receipt.v1`.
- `torghut_revision`: current build or Knative revision.
- `account_label`: account scoped by the proof floor, currently `PA3SX7FYNUTF`.
- `empirical_jobs`: readiness, authority, job ids, row ids, candidate ids, dataset refs, stale jobs, and artifact refs.
- `doc29`: `total`, `satisfied`, `stale`, `blocked`, `paper_gate_satisfied`, and blocker reasons.
- `runtime_profitability`: lookback, decision count, execution count, TCA sample count, and latest timestamps.
- `tca`: order count, last computed at, average absolute slippage, expected-shortfall coverage, and freshness state.
- `quant_ingestion`: account/window, status, max stage lag, and whether the lag is blocking or informational.
- `submission`: live submission gate, capital stage, promotion eligible total, and submit-disabled reason.
- `capital_effect`: `observe`, `proof_repair`, `paper_hold`, `live_hold`, or `live_block`.
- `repair_ladder`: ordered zero-notional repairs with expected unblock value.

Interpretation rules:

- Empirical jobs current plus doc29 blocked yields `capital_effect=paper_hold`, not paper admission.
- Empirical jobs current plus stale TCA yields `proof_repair` priority for TCA and execution-funnel repair.
- Missing receipt or invalid schema yields a Jangar source-binding fault, not a Torghut proof verdict.
- `paper_canary` can only advance after full-day simulation trace, doc29 paper gate, fresh TCA, scoped quant freshness,
  and Jangar proof truth window all agree.

## Trading Hypotheses And Guardrails

Hypothesis 1: Full-day execution funnel repair is the highest-value unblocker.

- Expected value: converts doc29 `paper_gate_satisfied` from blocked to measurable if it produces nonzero decisions,
  executions, order events, and TCA rows for the active candidate/dataset.
- Guardrail: zero notional; no live submit; require a complete completion trace and row-count proof.
- Success: at least `500` simulated decisions, nonzero executions, nonzero TCA samples, and doc29 paper gate no longer
  blocked by `missing_full_day_simulation_trace`.

Hypothesis 2: TCA refresh is required before any paper or live capital signal is trustworthy.

- Expected value: replaces `execution_tca_stale` with current post-cost evidence and reveals whether the candidate is
  still economically viable.
- Guardrail: zero notional; no paper admission from TCA alone.
- Success: TCA freshness <= `24h` before paper, expected-shortfall coverage > `95%`, and average absolute slippage
  inside the strategy budget before any capital warrant consumes it.

Hypothesis 3: Scoped quant ingestion lag should be repaired before market-hours paper canaries.

- Expected value: prevents global healthy metrics from hiding account/window staleness.
- Guardrail: closed-session lag can be informational, but market-hours lag above `15s` blocks paper.
- Success: account `PA3SX7FYNUTF`, window `15m`, max stage lag <= `15s` during market hours and no critical quant
  alerts for the candidate route.

## Implementation Scope

Engineer stage:

- Add `empirical_relay_receipt` to Torghut status/autonomy payloads.
- Use existing empirical job status, doc29 completion, proof floor, runtime profitability, and TCA summary builders.
- Add tests where empirical jobs are healthy but paper remains blocked by doc29 and stale TCA.
- Add tests where the receipt is missing or invalid and Jangar should classify a source-binding fault.
- Keep submit-disabled and zero-notional behavior unchanged.

Jangar engineer stage:

- Consume the receipt through the source-binding contract in the companion Jangar doc.
- Keep `empirical_jobs_disabled`, `empirical_relay_unconfigured`, `doc29_paper_gate_blocked`,
  `execution_tca_stale`, and `simple_submit_disabled` as separate reason codes.

## Validation Gates

Local validation:

- Torghut API tests covering `/trading/status`, `/trading/autonomy`, `/trading/completion/doc29`,
  `/trading/profitability/runtime`, and `/trading/tca`.
- Jangar control-plane tests proving healthy empirical jobs do not clear paper/live when doc29/TCA are blocked.
- Route contract snapshots for the new receipt schema.

Runtime validation after deployer sync:

- `/trading/status` and `/trading/autonomy` include the receipt.
- Receipt empirical section matches `/trading/empirical-jobs`.
- Receipt doc29 section matches `/trading/completion/doc29`.
- Receipt TCA section matches `/trading/tca?limit=5`.
- Jangar status consumes the receipt and no longer reports `empirical_jobs:endpoint:unknown`.
- Paper/live remain zero-notional until all downstream gates close.

## Rollout

Phase 0:

- Ship the Jangar Agents control-plane source-binding config correction.
- Verify Jangar can reach Torghut empirical status and that source-binding debt clears.

Phase 1:

- Add the Torghut receipt as an additive field.
- Keep existing proof-floor and doc29 gates as the authority for capital hold.
- Compare receipt interpretation against current Jangar material-action verdicts.

Phase 2:

- Require Jangar material-action verdicts to cite the receipt for empirical-job state.
- Keep paper/live blocked until receipt plus doc29 plus TCA plus quant plus submission gates agree.

## Rollback

If the receipt route regresses, remove only the additive receipt field or disable Jangar receipt consumption. Keep the
existing empirical jobs, proof floor, and doc29 routes.

If the source-binding correction causes Jangar to over-read empirical health, rollback Jangar consumption to shadow and
leave Torghut submit disabled. Do not enable paper or live as a rollback shortcut.

If TCA or doc29 repair produces inconsistent evidence, keep capital at zero notional and require a new receipt with the
contradiction recorded.

## Risks

- A healthy empirical receipt may create operator pressure for paper. Mitigation: receipt carries explicit paper/live
  blockers and capital effect.
- TCA thresholds may be too strict for some strategy families. Mitigation: thresholds are strategy-family inputs, but
  no family bypasses freshness and expected-shortfall coverage.
- Scoped quant lag can be expected while markets are closed. Mitigation: closed-session lag can be informational; market
  hours decide paper readiness.
- Route payload size can grow. Mitigation: receipt is summary-first and links to existing detailed route refs.

## Handoff

Engineer acceptance:

- Torghut emits `torghut.empirical-relay-receipt.v1` from status/autonomy routes.
- Tests prove empirical jobs can be healthy while paper remains held by doc29/TCA/quant/submission reasons.
- Receipt generation uses existing database-backed route summaries and does not require privileged SQL.

Deployer acceptance:

- After Jangar source-binding rollout, Jangar reads empirical jobs as healthy from Torghut.
- Torghut receipt still reports paper/live ineligible until doc29, TCA, scoped quant, and submission gates close.
- Any paper canary request cites the receipt id, doc29 gate id, TCA freshness, scoped quant window, and Jangar material
  verdict id before notional can move above zero.

# 88. Torghut Session Proof Budget Consumer and Capital Reentry Contract (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: secrets/RBAC/policies exist in GitOps and code, but compliance/governance designs are broader than current automated enforcement.
- Matched implementation area: Security, secrets, RBAC, audit, governance, and compliance.
- Current source evidence:
  - `argocd/applications/torghut/role.yaml`
  - `argocd/applications/torghut/rolebinding.yaml`
  - `argocd/applications/torghut/sealed-secrets.yaml`
  - `services/torghut/app/trading/autonomy/policy_checks.py`
  - `services/torghut/scripts/run_governance_policy_dry_run.py`
- Design drift note: Governance/compliance designs need tests and GitOps policy wiring before being treated as fully enforced.


## Decision

Torghut should consume Jangar material action settlements and use them to control session proof budgets. The profitable
next move is not to reopen paper/live submission. The profitable next move is to spend zero-notional proof budget on
the fastest repairs that can either refresh the empirical proof set, replay current rejected decisions, or falsify a
hypothesis before more market time is wasted.

I am choosing this because the live state is operationally available but not capital-ready. Torghut live revision
`torghut-00219` is serving. Postgres, ClickHouse, Alpaca, universe, and schema checks are healthy. The database is at
Alembic head `0029_whitepaper_embedding_dimension_4096`. But `/readyz` and `/trading/health` return 503 because the
live submission gate is closed with `simple_submit_disabled`, empirical jobs are degraded, and every hypothesis is at
zero capital. Direct SQL confirms 16 empirical job rows, but the latest row is from 2026-03-21. Runtime hypotheses are
registry-backed, with zero persisted `strategy_hypotheses` rows.

That evidence says learn and repair, not widen. Torghut should treat Jangar settlement as platform authority and its
own session proof budget as profit authority. Both must be fresh before paper or live capital reentry.

## Success Metrics

Success means:

1. Torghut status exposes the Jangar platform settlement digest consumed by the live submission gate;
2. each hypothesis has a current session proof budget decision: `none`, `repair`, `replay`, `paper_canary`, or
   `live_capital`;
3. stale empirical proof creates zero-notional repair budgets, not paper/live permission;
4. rejected current-session decisions can be replayed under budget without broker orders;
5. a Jangar `hold` or expired platform settlement blocks paper/live capital but does not block route health, replay,
   or empirical refresh;
6. paper reentry requires fresh Jangar platform settlement, fresh empirical proof, and fresh route/replay evidence for
   the hypothesis;
7. live reentry additionally requires current TCA, slippage, drawdown, kill-switch, and broker-route proof.

## Evidence Snapshot

All checks were read-only.

### Runtime and Cluster Evidence

- `kubectl get pods -n torghut -o wide` showed Torghut live, Torghut sim, Postgres, ClickHouse, Keeper, TA workers,
  options services, websocket forwarders, guardrail exporters, Symphony, and Alloy running.
- `GET http://torghut.torghut/trading/status` returned HTTP 200 with active revision `torghut-00219`, live mode,
  simple execution lane, scheduler running, and critical toggles aligned.
- `GET http://torghut.torghut/readyz` returned HTTP 503 with healthy Postgres, ClickHouse, Alpaca, universe, and
  database schema checks, but live submission gate closed.
- `GET http://torghut.torghut/trading/health` returned HTTP 503 for the same capital-readiness reason.
- `GET http://torghut.torghut/db-check` returned HTTP 200 with `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no head delta, and lineage warnings for historical parent forks.

### Database and Data Evidence

- Direct read-only SQL connected as `torghut_app` at `2026-05-05T19:27:38Z`.
- SQL reported Alembic head `0029_whitepaper_embedding_dimension_4096`.
- SQL reported 16 rows in `vnext_empirical_job_runs`, latest empirical job at `2026-03-21T09:03:22.150Z`.
- SQL reported zero rows in `strategy_hypotheses`; current runtime hypotheses come from `/app/config/trading/hypotheses`
  and are correctly surfaced by `/trading/status`.
- `/trading/status` reported candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35` for stale empirical jobs.

### Profitability Evidence

- Torghut reported three hypotheses:
  - `H-CONT-01`: shadow, capital multiplier `0`;
  - `H-MICRO-01`: blocked, capital multiplier `0`;
  - `H-REV-01`: shadow, capital multiplier `0`.
- `promotion_eligible_total=0` and `rollback_required_total=3`.
- The dependency quorum reason is `empirical_jobs_degraded`.
- The live submission gate reports `allowed=false`, `reason=simple_submit_disabled`, and `capital_stage=shadow`.

## Problem

Torghut has separated operational liveness from capital readiness, which is correct. The missing piece is a deterministic
consumer contract for what to do next when capital is held.

Without session proof budgets:

1. stale empirical jobs are visible but not converted into bounded repair work;
2. current rejected decisions do not become replay evidence;
3. each hypothesis competes informally for repair time;
4. platform holds from Jangar and profit holds from Torghut are easy to conflate;
5. paper/live capital reentry can be argued from partial facts.

The system needs one rule: platform settlement plus session proof budget, both fresh, or no paper/live capital.

## Alternatives Considered

### Option A: Refresh Global Empirical Jobs First

Run all empirical jobs for the current candidate and dataset, then reconsider capital.

Pros:

- directly addresses the largest current blocker;
- easy to reason about;
- likely useful for all three hypotheses.

Cons:

- ignores current rejected-decision evidence;
- may spend compute on a stale or wrong market window;
- does not consume Jangar platform settlement;
- gives no hypothesis-specific ranking.

Decision: keep as the first default repair class, but do not make it the whole architecture.

### Option B: Reopen Paper Submission in Shadow

Use healthy schema and broker connectivity to collect paper fills.

Pros:

- creates fresh execution samples quickly;
- validates broker-route behavior under current market conditions;
- can improve TCA freshness.

Cons:

- bypasses stale empirical proof;
- ignores Jangar platform holds;
- can create misleading samples for hypotheses with missing features or drift checks;
- violates the separation between repair and capital authority.

Decision: reject for current state.

### Option C: Consume Jangar Settlement and Issue Session Proof Budgets

Treat Jangar platform settlement as the platform side of authority and Torghut session proof budget as the profit side.
Run zero-notional proof work until both sides are fresh enough for paper or live reentry.

Pros:

- aligns platform safety and profitability proof;
- keeps broker notional at zero during repair;
- ranks repairs by session value and hypothesis blockers;
- provides auditable proof for paper/live reentry;
- lets healthy service routes stay available while capital remains held.

Cons:

- requires a new consumer field and budget state machine;
- scoring is approximate at first;
- demands strict operator language so proof budget is not read as capital approval.

Decision: select Option C.

## Chosen Architecture

### JangarSettlementRef

Torghut stores and emits the platform settlement it consumed:

```text
jangar_settlement_ref
  settlement_digest
  action_class              # paper_submit, live_submit, repair, replay
  account
  release_digest
  evidence_cut_digest
  decision
  fresh_until
  negative_evidence_refs
  route_ref
```

An expired, missing, or `hold` settlement blocks paper/live capital. It does not block zero-notional repair and replay.

### SessionProofBudget

Torghut creates one budget per account, session, and hypothesis:

```text
session_proof_budget
  budget_id
  account
  session_window
  hypothesis_id
  strategy_family
  jangar_settlement_digest
  decision                  # none, repair, replay, paper_canary, live_capital
  max_notional
  max_runtime_minutes
  max_compute_budget
  allowed_repair_classes
  success_condition
  falsification_condition
  stop_condition
  issued_at
  expires_at
  state
```

The default `max_notional` is zero. Only `paper_canary` or `live_capital` can raise it, and both require fresh Jangar
settlement plus fresh profit evidence.

### Initial Repair Ranking

The first ranking should be deterministic and conservative:

1. refresh empirical jobs for candidate `intraday_tsmom_v1@prod` and dataset
   `torghut-full-day-20260318-884bec35`;
2. replay current rejected decisions for `H-CONT-01` because it has the fewest non-platform blockers;
3. repair market-context freshness for `H-REV-01`;
4. repair feature coverage and drift checks for `H-MICRO-01`;
5. refresh TCA and slippage proof only after current replay or paper-canary evidence exists;
6. request Jangar platform repair when settlement is held for stale stage, image proof, or route proof reasons.

## Implementation Scope

Engineer stage:

- add `jangar_settlement_ref` to Torghut status and live submission gate payloads;
- add session proof budget calculation from empirical jobs, hypothesis status, replay evidence, TCA freshness, and
  Jangar settlement;
- persist budget decisions or expose them from a deterministic projection before enforcement;
- add tests for stale empirical jobs, expired settlement, zero-notional repair, replay-only budget, and paper reentry;
- make broker admission fail closed unless budget decision permits paper/live notional.

Deployer stage:

- validate Jangar settlement route from the Torghut runtime environment;
- run one full market session in observe mode and compare current capital gate output with budget output;
- run one full session in shadow mode with zero-notional repair budgets;
- only then allow paper-canary budget for the lowest-blocker hypothesis.

## Validation Gates

- `/trading/status` includes Jangar settlement digest, decision, expiry, and negative evidence summary.
- `/trading/health` remains degraded for paper/live capital while empirical jobs are stale, even if platform settlement
  is healthy.
- `H-CONT-01` can receive a replay or empirical-refresh budget without any broker notional.
- `H-MICRO-01` cannot receive paper budget while feature rows and drift checks are missing.
- `H-REV-01` cannot receive paper budget while market-context freshness is missing.
- Paper-canary budget requires fresh empirical jobs, fresh Jangar settlement, replay or route proof, kill-switch proof,
  and explicit nonzero `max_notional`.
- Live-capital budget requires paper-canary evidence plus current TCA and drawdown proof.

## Rollout

1. Observe: emit budget projection and Jangar settlement ref, no behavior change.
2. Shadow: compare current live submission gate with budget gate for one full market session.
3. Zero-notional repair: allow empirical refresh and replay budgets while broker notional remains zero.
4. Paper canary: enable only for the lowest-blocker hypothesis after fresh platform and profit proof.
5. Live capital: require paper evidence, TCA proof, drawdown proof, broker-route proof, and explicit operator approval.

## Rollback

- Disable budget enforcement and return broker admission to the existing live submission gate.
- Keep budget records for audit and replay.
- Revert paper-canary enablement before reverting observe/shadow projections.
- Rollback triggers:
  - budget gate allows paper/live without fresh Jangar settlement;
  - budget gate allows paper/live with stale empirical jobs;
  - replay budget produces inconsistent decision state for the same evidence cut;
  - paper canary generates route or TCA evidence outside expected risk limits.

## Risks

- Stale historical TCA can make current profitability look safer than it is.
- Registry-backed hypotheses and zero persisted `strategy_hypotheses` rows are acceptable today, but enforcement should
  not depend on missing persistence.
- Platform settlement and profit budget are separate authorities; either one can block capital.
- First scoring is ordinal. It should not be used to justify live capital until enough replay and paper evidence exists.

## Handoff Contract

Engineer acceptance:

- Torghut emits Jangar settlement ref and session proof budget projection;
- stale empirical proof maps to zero-notional repair budget;
- broker admission consumes budget decision and fails closed for paper/live;
- tests cover stale proof, expired platform settlement, per-hypothesis blockers, and paper/live reentry gates.

Deployer acceptance:

- one observe session and one shadow session are recorded;
- first paper-canary candidate is selected from evidence, not intuition;
- rollback switch is tested before paper-canary enablement;
- no live capital is enabled until paper-canary, TCA, drawdown, and settlement gates all pass.

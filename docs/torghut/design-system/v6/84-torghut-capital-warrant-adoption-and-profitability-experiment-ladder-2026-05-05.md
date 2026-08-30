# 84. Torghut Capital Warrant Adoption and Profitability Experiment Ladder (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

Torghut should adopt order-admission warrants through a **Capital Warrant Adoption and Profitability Experiment
Ladder**. The ladder separates three concerns that are currently easy to collapse: route liveness, capital authority,
and profit hypothesis quality. A Torghut route may be healthy and a strategy may remain useful for observe or replay,
but non-shadow broker admission requires a fresh warrant bound to a Jangar capital decision and a local profit-proof
cut.

The current runtime evidence supports a fail-closed capital stance:

- `/healthz` returned `{"status":"ok","service":"torghut"}`;
- `/db-check` returned `ok=true` and `schema_graph_lineage_ready=true`;
- `/trading/status` returned `live_submission_gate.allowed=true`, `reason="ready"`, and `capital_stage="live"`;
- the same response showed the hypothesis dependency quorum `block` on `empirical_jobs_degraded`;
- all three loaded hypotheses were shadow or blocked, `promotion_eligible_total=0`, and
  `rollback_required_total=3`;
- `torghut-ws` and `torghut-ws-options` were running but had recent restarts;
- Torghut events showed fresh rollout churn, startup/readiness probe failures, completed migrations and backfills, and
  ClickHouse pods matching multiple PodDisruptionBudgets.

I am choosing a ladder instead of a one-shot capital freeze because Torghut still needs observe, repair, replay, and
paper evidence generation to become profitable. The right response is not to stop learning. The right response is to
make non-shadow broker admission impossible until proof is current, replay evidence is tied to the same account/window,
and Jangar's capital decision agrees.

## Scope and Success Metrics

This document defines the Torghut side of adoption for the Jangar settlement ladder. It is not a new strategy thesis.
It is the cutover contract for making the existing warrant and replay-auction architecture enforceable.

Success means:

1. current May 5 evidence produces `hold` or `shadow_only` for non-shadow broker admission;
2. status routes, scheduler decisions, and broker warrant minting all use the same proof cut;
3. replay auctions rank hypotheses by measurable post-cost evidence before capital is widened;
4. rollback disables enforcement without deleting proof or replay evidence;
5. each promoted hypothesis has a dated, testable profitability hypothesis and a stop condition.

## Evidence Snapshot

### Cluster and Rollout Evidence

Read-only Kubernetes evidence showed Torghut serving but actively rolling:

- `kubectl get pods -n torghut -o wide` showed Torghut, Torghut simulation, Postgres, ClickHouse, ClickHouse Keeper,
  websocket forwarders, options services, TA services, and exporters running.
- `torghut-db-1` and ClickHouse pods were running, with one recent database restart on the sampled Postgres pod.
- events showed a fresh `torghut-db-migrations` job, `torghut-empirical-jobs-backfill`, whitepaper bootstrap and
  semantic backfill jobs, and Torghut simulation revision turnover.
- events also showed startup and readiness probe failures during revision turnover and ClickHouse pods matching
  multiple PDBs.

Interpretation: the platform can serve and backfill, but rollout and data maintenance were still moving during the
evidence window. That is not a safe moment to infer live capital readiness from route liveness.

### Source and Test Evidence

The source split matters:

- `services/torghut/app/main.py` is a large route surface and contains `_build_live_submission_gate_payload`.
- `services/torghut/app/trading/submission_council.py` is the stronger proof-aware admission surface.
- `services/torghut/tests/test_trading_api.py` and `services/torghut/tests/test_submission_council.py` already include
  many gate and route-parity tests.

The line counts are a signal of blast radius: `main.py` has 3981 lines, `submission_council.py` has 1196 lines,
`test_trading_api.py` has 3505 lines, and `test_submission_council.py` has 603 lines. The adoption ladder should avoid
another route-local decision and instead force all capital paths through the shared proof cut.

The missing regression is not whether Torghut can form a live-submission payload. It is whether the broker-bound path
rejects non-shadow orders when Jangar dependency quorum blocks, empirical jobs are degraded, and every hypothesis is
shadow or blocked even though the route says live submission is ready.

### Database, Data, and Profit Evidence

Allowed application evidence:

- `/db-check` returned `ok=true` and `schema_graph_lineage_ready=true`.
- Direct CNPG SQL was blocked by the runner service account because it cannot create `pods/exec` in `torghut`.
- Migration and backfill jobs ran in the sampled window.
- `/trading/status` reported zero promotion-eligible hypotheses and three rollback-required hypotheses.
- Hypothesis reasons included `jangar_dependency_block`, `signal_lag_exceeded`, `market_context_stale`,
  `drift_checks_missing`, and `feature_rows_missing`.
- TCA proxy fields were present, including `tca_order_count=13775`, but average absolute slippage was far above the
  sample promotion contracts shown in the response.

Interpretation: schema is available, but profit authority is not current enough for non-shadow capital. The ladder must
make proof freshness and post-cost quality explicit before capital widens.

## Problem

Torghut currently has a false-positive shape that is dangerous for live trading: the service is healthy and a liveness
gate can say ready while the profitability and dependency surfaces say no.

There are three separate questions:

1. Can the service answer routes and continue repair work?
2. Is a hypothesis eligible to receive any non-shadow capital?
3. If eligible, which hypothesis deserves scarce capital based on post-cost evidence and replay quality?

Today those questions can be read from different fields. The capital warrant architecture answers question two. The
replay capital auction answers question three. This adoption ladder defines how Torghut gets from current liveness
behavior to enforceable, profit-seeking admission without halting evidence generation.

## Options Considered

### Option A: Patch the Status Route Only

Make `/trading/status` display `live_submission_gate.allowed=false` when dependency quorum blocks or all hypotheses are
shadow.

Pros:

- fastest visible improvement;
- reduces operator confusion;
- small code change.

Cons:

- broker submission can still bypass the route;
- scheduler and status paths can drift again;
- does not create replay-backed capital competition;
- no durable proof object for audit.

Decision: reject as the architecture answer. It can be one implementation step, but it is not sufficient.

### Option B: Freeze All Trading Until Empirical Jobs Recover

Set all trading paths to observe-only or disabled until empirical jobs, market context, and dependency quorum are
healthy.

Pros:

- safest short-term capital posture;
- easy to explain;
- avoids false positive live readiness.

Cons:

- blocks shadow evidence and replay learning if applied too broadly;
- does not improve the profit-selection mechanism;
- creates pressure for manual overrides during market hours.

Decision: reject as the steady-state design. Capital should freeze, but observe, shadow, repair, and replay should keep
working.

### Option C: Capital Warrant Adoption and Profitability Experiment Ladder

Introduce a staged ladder: route parity, shadow warrants, broker warning mode, broker enforcement, replay auction, and
controlled capital widening. Each step requires measurable proof and preserves repair paths.

Pros:

- blocks non-shadow capital without stopping learning;
- prevents route-local liveness from becoming broker authority;
- gives profitability experiments a measurable promotion path;
- makes rollback configuration-only.

Cons:

- requires route, scheduler, and broker path coordination;
- requires storage for warrants and replay auction outcomes;
- slows live capital reentry until proof catches up.

Decision: select Option C.

## Chosen Architecture

### CapitalWarrantAdoptionState

Torghut should expose and persist a compact adoption state per account/window:

```text
capital_warrant_adoption_state
  account
  window
  release_digest
  rung                         # route_parity, shadow_warrant, broker_warn, broker_enforce, replay_auction, widen
  enforcement_mode             # off, shadow, warn, enforce
  jangar_decision_digest
  local_profit_proof_digest
  warrant_digest
  replay_auction_digest
  allowed_capital_stage
  max_notional
  blocked_reasons
  observed_at
  fresh_until
  rollback_switch
```

This state is not an excuse to add a second admission path. Broker admission still consumes `OrderAdmissionWarrant`.
The adoption state tells operators and tests which rung is active and why.

### Rung 1: Route Parity

Make `/trading/status`, `/trading/health`, `/readyz`, scheduler state, and runtime control-plane snapshots report the
same live-submission and capital-proof interpretation.

Promotion gate:

- current evidence yields non-shadow `allowed=false`;
- blocked reasons include Jangar dependency block, stale empirical jobs, and no promotion-eligible hypotheses;
- all routes agree on the shared gate payload.

Rollback:

- return route labels to liveness-only while keeping capital-proof diagnostics.

### Rung 2: Shadow Warrants

Mint warrants in shadow mode for every candidate order, but do not reject at the broker. Record the decision that would
have been enforced.

Promotion gate:

- every order candidate has either a warrant or an explicit missing-warrant reason;
- missing Jangar capital decision blocks shadow non-live approval;
- warrant expiries are shorter than the signal freshness budget.

Rollback:

- disable shadow minting; keep route parity.

### Rung 3: Broker Warning Mode

The broker adapter validates warrants and logs rejects, but does not block orders yet. This rung exists to catch path
coverage gaps.

Promotion gate:

- status, scheduler, and broker adapter produce the same accept/reject decision for a full market session or three
  scheduled control-plane cycles;
- no path submits a non-shadow order without a warrant;
- warning-mode reject rate is understood by reason code.

Rollback:

- turn broker validation back to shadow-only.

### Rung 4: Broker Enforcement

Reject non-shadow broker submission without a fresh warrant bound to Jangar's capital decision and local profit proof.

Promotion gate:

- regression tests prove current May 5 evidence rejects non-shadow admission;
- emergency stop and manual override cannot bypass missing warrant without an expiring, scoped override ref;
- order rejection is observable without logging secrets or broker credentials.

Rollback:

- disable enforcement and leave warning-mode validation on.

### Rung 5: Replay Capital Auction

Use replay and paper evidence to rank hypotheses for scarce capital. The auction does not allocate live capital unless
the broker enforcement rung is healthy.

Promotion gate:

- each hypothesis has a dated experiment statement;
- replay output includes gross return, post-cost return, slippage, drawdown, sample count, and regime slice;
- at least one competing baseline is present;
- stale market-context or signal inputs veto widening rather than silently lowering confidence.

Rollback:

- stop widening from auction output; preserve replay records for diagnosis.

### Rung 6: Controlled Widening

Allow limited non-shadow capital only when Jangar external-capital decision, local profit proof, broker warrants, and
replay auction all agree for the same account/window.

Promotion gate:

- `rollback_required_total=0`;
- dependency quorum is not `block`;
- all live hypotheses have fresh post-cost evidence;
- max notional and loss limits are configured;
- deployer has verified rollback switch behavior.

Rollback:

- return to broker enforcement with max notional zero, preserving shadow and replay.

## Profitability Hypotheses

Every widening candidate must name a measurable hypothesis before capital moves:

- `H-CONT-01`: continuation can produce positive post-cost expectancy when signal lag is below 90 seconds and
  dependency quorum allows.
- `H-MICRO-01`: microstructure breakout can outperform continuation only when feature rows and drift checks are fresh.
- `H-REV-01`: event reversion can receive capital only when market context is fresher than 120 seconds and news/regime
  inputs are not stale.

The replay auction must compare these against a zero-trade baseline and an observe-only baseline. A hypothesis that
fails its sample-count or slippage contract remains shadow even if route liveness is healthy.

## Engineer Handoff

Implement in this order:

1. Make simple mode call the shared proof-aware submission council or an equivalent shared helper.
2. Add route-parity tests across status, health, ready, runtime, and scheduler paths.
3. Add shadow warrant creation and a compact adoption state.
4. Add broker adapter validation in warning mode.
5. Add broker enforcement with scoped override semantics.
6. Add replay auction records and ranking output.
7. Add widening checks that require Jangar digest, local profit proof, warrant digest, and replay digest agreement.

The first code PR should stop the false-positive route shape. The broker enforcement PR should land only after warning
mode has path coverage.

## Deployer Handoff

Deploy in rung order. Do not enable non-shadow capital because a Torghut pod is ready or `/healthz` returns ok. Enable
it only when the active adoption state is at broker enforcement or higher, the Jangar digest matches the current
account/window, and replay auction evidence is fresh.

During rollout, preserve these repair paths:

- observe and shadow decisions;
- replay and backfill jobs;
- status and diagnostics routes;
- broker warning logs;
- manual override with expiry and notional cap.

## Validation

Required validation:

- `pytest services/torghut/tests/test_trading_api.py -k live_submission_gate`
- `pytest services/torghut/tests/test_submission_council.py`
- broker-adapter regression proving missing or expired warrant rejects non-shadow orders;
- route smoke for `/healthz`, `/db-check`, and `/trading/status`;
- replay auction fixture with at least one losing and one winning candidate;
- docs check with `bunx oxfmt --check` for touched markdown files.

If local Python environment setup is unavailable, the engineer must run the equivalent `uv run --frozen pytest`
commands in CI and include the failure reason in the PR body.

## Rollout

Start with route parity in the live service. Enable shadow warrants for one account/window. Move to broker warning mode
for at least one market session or three scheduled Jangar rollout cycles. Enable broker enforcement with max notional
zero, then enable replay auction, and only then allow controlled widening.

## Rollback

Rollback is configuration-first:

- `capitalWarrants.shadow.enabled=false`
- `capitalWarrants.broker.warnOnly=true`
- `capitalWarrants.broker.enforce=false`
- `capitalWarrants.replayAuction.wideningEnabled=false`
- `capitalWarrants.maxNotional=0`

Do not delete warrant or replay records during rollback. They are the audit trail for why capital was held or allowed.

## Risks

- Warning mode can become permanent if no owner is assigned. Each rung needs an expiry and owner.
- Broker hot-path validation must not call Jangar synchronously. It should validate a local, fresh decision digest.
- Replay auctions can overfit if they do not include a baseline and regime slice.
- Manual overrides can recreate the old risk if they are broad or long-lived.
- If route parity is skipped, the system will again have one field that says live and another that says blocked.

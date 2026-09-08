# 72. Torghut Cross-Plane Evidence Epochs and Portfolio Proof Lanes (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Executive summary

The decision is to make Torghut research advancement, portfolio proof, and capital staging depend on one cross-plane
evidence epoch. The epoch must prove Jangar runtime authority, Torghut runtime health, data freshness, artifact
platform parity, and post-cost portfolio evidence before a lane can advance beyond shadow.

I am not choosing a narrow endpoint fix or a pure research acceleration plan. The May 5 assessment showed a mixed
system: Jangar served `/ready` but blocked execution trust, Torghut served `/healthz` but timed out on readiness and
trading-status surfaces, the simulation lane hit `ImagePullBackOff` on a promoted digest, empirical jobs were stale,
and direct Postgres/ClickHouse shell checks were blocked by RBAC. That is exactly the condition where faster research
can generate more candidates than the runtime can honestly certify.

The tradeoff is more receipt plumbing before promotion can move faster. I am taking that trade because the profitable
system is not the one that finds the most candidates. It is the one that can prove which runtime, data, and artifact
truth a profitable portfolio claim belongs to.

## Mission inputs and success criteria

Inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster/source/database state and merge architecture artifacts that improve Jangar resilience and
  Torghut quant profitability

Success means:

1. every research run, portfolio candidate, and promotion decision cites one `evidence_epoch_id`;
2. every epoch cites Jangar authority, Torghut service health, data/schema freshness, empirical-job freshness, artifact
   parity, and portfolio proof receipts;
3. non-shadow advancement is blocked by stale empirical jobs, timed-out Torghut health, missing Jangar collaboration
   runtime, or image digest/platform drift;
4. portfolio candidates targeting `$500/day` post-cost net PnL prove contribution by lane, day, regime, symbol
   concentration, drawdown, slippage, and holdout window;
5. rollback can quarantine one epoch without deleting research history or database records.

## Assessment snapshot

### Cluster health, rollout, and events

The live cluster is mixed, not down.

- `kubectl get pods -n torghut -o wide`
  - `torghut-00201-deployment-79df678c95-xvzsm` was `2/2 Running`.
  - `torghut-db-1`, ClickHouse replicas, ClickHouse Keeper, TA, TA taskmanagers, and `torghut-ws` were running.
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` was `0/2 ImagePullBackOff`.
- `kubectl get events -n torghut --sort-by=.lastTimestamp`
  - recorded `ErrImagePull` and `ImagePullBackOff` for
    `registry.ide-newton.ts.net/lab/torghut@sha256:d278a4d4267f011ba559dc51401acc6ac8f43d44a766b61f29a4d01859cce5cf`;
  - the registry error was `no match for platform in manifest`;
  - `torghut-00201` later became ready, so the failure is lane/node/digest-specific rather than a total outage.
- `curl http://torghut.torghut.svc.cluster.local/healthz`
  - returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `curl` to `/readyz`, `/trading/health`, `/db-check`, and `/trading/status`
  - timed out during the assessment window.
- `curl http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - returned `ready=false` with four stale completed jobs.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - returned `torghut_clickhouse_guardrails_last_scrape_success 1.0`;
  - returned `freshness_fallback_total` equal to `0.0` for `ta_signals` and `ta_microbars`.
- `curl http://jangar.jangar.svc.cluster.local/ready`
  - returned HTTP 200;
  - reported `execution_trust.status="degraded"`;
  - reported stage staleness for `jangar-control-plane` and `torghut-quant`;
  - reported `runtime_kit_component_missing:nats_cli` on the collaboration runtime kit.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - returned HTTP 200;
  - reported Jangar database healthy with `25/25` migrations applied;
  - reported rollout degradation because `agents-controllers` had desired replicas `2` and ready replicas `1`;
  - reported dependency quorum `block` with `agents_controller_unavailable`, `workflow_runtime_unavailable`, and
    `empirical_jobs_degraded`.
- Jangar quant health for `account=paper&window=15m`
  - timed out during the assessment window.

Interpretation: liveness is not promotion authority. Torghut needs stage-specific receipts that distinguish a running
live revision, a failed sim lane, a timed-out status route, stale empirical truth, and a healthy ClickHouse exporter.

### Source architecture and high-risk modules

Torghut already has research machinery worth preserving.

- Current workspace count for `services/torghut/app`, `services/torghut/scripts`, and `services/torghut/tests` was
  `231941` lines.
- `services/torghut/tests` contained `149` test files.
- Large and risky modules remain:
  - `services/torghut/app/trading/autonomy/lane.py` at `7377` lines;
  - `services/torghut/app/trading/autonomy/policy_checks.py` at `6072` lines;
  - `services/torghut/app/trading/research_sleeves.py` at `5254` lines;
  - `services/torghut/app/trading/scheduler/pipeline.py` at `4273` lines.
- The April strategy-factory base exists:
  - `hypothesis_cards.py`, `candidate_specs.py`, `portfolio_candidates.py`, `objectives.py`, and
    `runtime_closure.py` are in tree;
  - `run_whitepaper_autoresearch_profit_target.py` is in tree;
  - tests exist for MLX autoresearch, strategy autoresearch, runtime closure, and the profit-target runner.
- GitOps manifests reuse the same promoted Torghut digest in live, sim, DB migration, analysis templates, and
  historical simulation.
- Live Torghut is configured with `TRADING_MODE=live`, while `TRADING_EMPIRICAL_JOBS_HEALTH_REQUIRED=false` and
  `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=false` remain present in the live manifest.

Interpretation: the next leverage is not a broad rewrite. It is additive receipt producers and consumers around the
existing strategy factory, runtime closure, scheduler, and GitOps release surfaces.

### Database, data, and consistency evidence

Direct database reads were blocked, so production gates cannot require privileged shell access.

- `kubectl cnpg status -n torghut torghut-db`
  - failed with a forbidden CNPG cluster read.
- `kubectl cnpg psql -n torghut torghut-db`
  - failed because the service account cannot create `pods/exec`.
- `kubectl exec` into ClickHouse
  - failed because the service account cannot create `pods/exec`.
- Torghut `/db-check`
  - timed out.
- ClickHouse guardrail exporter
  - was reachable and successful.
- Torghut empirical jobs
  - were reachable and stale.
- Jangar database status
  - was reachable and healthy.
- The first two memory retrieval attempts through the repo helper failed with `ECONNRESET`, while Jangar `/ready`
  reported the memory provider configured and healthy.

Interpretation: typed receipts and exporters are the correct gate surface. Timeout and transport reset are data states,
not blank values.

## Problem statement

Torghut has evolved in two useful directions:

1. Jangar now has admission passports, runtime kits, recovery epochs, backlog seats, and dependency quorum.
2. Torghut now has whitepaper autoresearch, MLX proposal ranking, portfolio candidates, runtime closure, and
   profit-proof contracts.

The missing layer is a cross-plane evidence epoch that says:

- this Jangar authority was current;
- this Torghut runtime and sim artifact set could pull and serve;
- this schema and data freshness state was current;
- this portfolio evidence bundle was current;
- this promotion decision consumed those exact facts.

Without that layer, research can advance on stale data, sim can fail after a live digest appears usable, empirical jobs
can remain stale while live mode is present, and operators have to manually interpret fragmented evidence.

## Alternatives considered

### Option A: fix the endpoint and image failures first

Pros:

- fastest path to a greener cluster;
- reduces immediate operator noise.

Cons:

- does not prevent the next platform-incompatible digest from reaching sim or analysis;
- does not bind strategy promotion to Jangar runtime authority;
- does not give the research system a portable proof that data and runtime evidence were fresh.

Decision: rejected as the primary architecture. Necessary implementation work, but insufficient.

### Option B: accelerate Strategy Factory and MLX research

Pros:

- highest upside if runtime and data planes are already trustworthy;
- directly builds on the April 2026 implementation contract.

Cons:

- current evidence says runtime and data truth are not yet trustworthy enough;
- creates candidate volume before the system can prove candidates honestly;
- leaves stale jobs and timed-out status as generic blockers.

Decision: rejected for this phase. Research acceleration should continue behind epoch-gated proof lanes.

### Option C: cross-plane evidence epochs and portfolio proof lanes

Pros:

- addresses every failure observed in this run;
- preserves Strategy Factory and MLX upside;
- gives engineers and deployers deterministic rollout, validation, and rollback gates;
- does not require privileged DB or ClickHouse shell access.

Cons:

- adds receipt compiler work before promotion can move faster;
- requires careful additive wiring across Jangar and Torghut;
- forces timeout and stale states to become explicit objects.

Decision: selected.

## Decision

Adopt Option C.

Torghut will introduce cross-plane evidence epochs and portfolio proof lanes. Jangar remains the control-plane
authority compiler. Torghut remains the trading, replay, and capital authority. Neither system may infer the other
system's truth from a raw route timeout, a green liveness check, or a successful pod start.

## Architecture

### Evidence epoch

Add an append-only Torghut evidence epoch:

```text
evidence_epoch_id
account_label
stage_scope
created_at
fresh_until
decision
reason_codes
jangar_authority_receipt_id
jangar_runtime_kit_receipt_id
torghut_service_health_receipt_id
torghut_schema_receipt_id
torghut_data_freshness_receipt_id
torghut_empirical_receipt_id
artifact_parity_receipt_id
portfolio_proof_receipt_ids
rollback_receipt_id
```

Allowed decisions:

- `shadow_only`
- `research_allowed`
- `paper_allowed`
- `canary_allowed`
- `live_allowed`
- `scale_allowed`
- `quarantined`

Rules:

- `live_allowed` and `scale_allowed` require every required receipt to be fresh.
- `paper_allowed` requires runtime, schema, data, and artifact receipts.
- empirical staleness can only be tolerated in a bounded repair-probe decision and must be priced in the portfolio
  proof.
- `quarantined` is sticky until a newer epoch supersedes it.

### Service health receipt

Torghut should emit one bounded receipt per role:

- `torghut-live`
- `torghut-sim`
- `db-migration`
- `analysis-template-runtime-ready`
- `analysis-template-activity`
- `analysis-template-artifact-bundle`
- `historical-simulation`

Each receipt records endpoint/job name, image digest, revision, node architecture when known, liveness, readiness,
`/db-check`, `/trading/status`, timeout budget, and reason codes.

Timeouts must be explicit:

- `timeout:readyz`
- `timeout:db_check`
- `timeout:trading_status`
- `timeout:quant_health`

### Artifact parity receipt

The artifact parity receipt prevents a digest that works on one node from silently failing another lane.

Inputs:

- GitOps image refs under `argocd/applications/torghut/**`;
- release-contract digest;
- registry manifest platform metadata when available;
- node architecture inventory;
- recent pull-failure events.

Decisions:

- `pass`
- `lane_partial`
- `fail_missing_platform`
- `fail_manifest_unreadable`
- `fail_gitops_runtime_drift`

Sim, live, DB migration, analysis templates, and historical simulation may share a digest only when that digest has a
platform entry for every schedulable node architecture in the target namespace.

### Data freshness and schema receipt

Inputs:

- `/db-check`;
- `/trading/empirical-jobs`;
- ClickHouse guardrail exporter metrics;
- source-specific freshness witnesses;
- schema lineage warnings and errors;
- empirical artifact timestamps.

Rules:

- `/db-check` timeout blocks `canary_allowed`, `live_allowed`, and `scale_allowed`.
- stale empirical jobs block `live_allowed` unless the target lane is explicitly a bounded repair-probe lane.
- ClickHouse guardrail exporter success can serve as the data receipt when direct ClickHouse exec is forbidden.
- unknown freshness is allowed only for shadow research and must be recorded.

### Portfolio proof lane

Each portfolio proof receipt includes:

- `portfolio_candidate_id`;
- source hypothesis and whitepaper claim ids;
- candidate spec ids;
- data snapshot id and freshness receipt id;
- runtime closure artifact refs;
- post-cost net PnL per day;
- contribution by sleeve, day, symbol, and regime;
- best-day share, worst-day loss, drawdown, realized or calibrated slippage;
- active-day ratio and notional utilization;
- holdout result;
- sequential trial state;
- invalidation clauses.

The portfolio target remains `$500/day` post-cost net PnL. A single sleeve may be below target if it improves the
portfolio after correlation, concentration, drawdown, and execution-cost penalties.

Hard guardrails:

- no stale tape without a `stale_tape` blocker;
- no scalar leaderboard without constraint witnesses;
- no MLX-only promotion;
- no whitepaper-derived candidate without claim lineage and contradiction handling;
- no live capital without runtime-native closure and a fresh evidence epoch.

## Implementation scope

Engineer stage should implement additive surfaces first:

1. `services/torghut/app/trading/evidence_epochs.py`
   - dataclasses and pure validators for epoch decisions.
2. `services/torghut/app/trading/evidence_receipts.py`
   - receipt builders for service health, data freshness, schema state, artifact parity, and portfolio proof.
3. `services/torghut/app/models/entities.py`
   - append-only `evidence_epochs` and `evidence_receipts` tables.
4. Alembic migration
   - no destructive migration.
5. `services/torghut/app/main.py`
   - `GET /trading/evidence-epochs/latest` and `GET /trading/evidence-epochs/{id}`.
6. `services/torghut/app/trading/discovery/runtime_closure.py`
   - attach portfolio proof receipts to runtime closure outputs.
7. `services/torghut/tests/`
   - timeout, stale empirical, image parity, schema, and portfolio proof regressions.

Deployer stage should add a pre-promotion artifact parity check, a smoke receipt compiler, and a rollback command that
marks the current epoch `quarantined` before reverting GitOps image or strategy config.

## Validation gates

Required local checks for engineer changes:

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen pytest tests/test_evidence_epochs.py tests/test_runtime_closure.py`
- `cd services/torghut && uv run --frozen python scripts/check_migration_graph.py`

Required deployer checks:

- `kubectl get pods -n torghut -o wide`
- `kubectl get events -n torghut --sort-by=.lastTimestamp`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/healthz`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/readyz`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/db-check`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/trading/status`
- `curl --max-time 8 http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m`
- `curl --max-time 8 http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`

Acceptance gates:

- no Torghut live, sim, migration, analysis, or historical simulation pod reports `ImagePullBackOff`;
- Jangar dependency quorum is not `block` for the target consumer;
- Torghut readiness, DB, status, empirical, quant-health, and ClickHouse receipts are fresh;
- portfolio proof exists before non-shadow capital;
- the latest epoch decision matches the requested stage.

## Rollout and rollback

Rollout phases:

1. Shadow receipts
   - emit all receipts without blocking and compare decisions with current status.
2. Research and paper enforcement
   - require epochs for new research and paper proof; leave live capital unchanged.
3. Canary enforcement
   - require epochs for canary live capital; allow repair-probe only when degraded evidence is explicit.
4. Live and scale enforcement
   - require complete fresh epochs and artifact parity across live, sim, migration, and analysis lanes.

Rollback is epoch-scoped:

- artifact parity failure quarantines the epoch and reverts the GitOps digest through release PR flow;
- data freshness failure blocks paper/canary/live advancement while preserving shadow research;
- portfolio proof failure revokes only that portfolio proof receipt;
- Jangar runtime authority failure blocks plan/implement/verify advancement and capital promotion, not serving.

## Risks and mitigations

Risk: the receipt layer becomes another generic status page.

Mitigation: every receipt has an id, producer, fresh-until timestamp, reason codes, and consumer list.

Risk: engineers overfit the `$500/day` target.

Mitigation: portfolio proof requires holdout, contribution decomposition, sequential state, concentration limits, and
stale-tape blockers.

Risk: one missing non-critical receipt deadlocks everything.

Mitigation: stage decisions are separated: `shadow_only`, `research_allowed`, `paper_allowed`, `canary_allowed`,
`live_allowed`, and `scale_allowed`.

Risk: deployers bypass receipts with manual DB shell checks.

Mitigation: this assessment already proved shell checks are not universally available; typed receipts and exporters
are the gate.

## Handoff to engineer

Build the receipt model first, not the final enforcement switch.

Acceptance gates:

1. validators reject missing Jangar authority, Torghut status timeout, stale empirical jobs, missing artifact parity,
   and stale data for non-shadow decisions;
2. the latest-epoch endpoint returns all receipt ids and reason codes;
3. runtime closure attaches portfolio proof without changing live capital behavior;
4. tests cover timeout, stale empirical, image parity failure, and portfolio proof failure.

## Handoff to deployer

Deploy shadow mode first.

Acceptance gates:

1. the deployed epoch endpoint produces a receipt even when one input times out;
2. no Torghut runtime, sim, migration, analysis, or historical simulation pod reports `ImagePullBackOff`;
3. Jangar control-plane status does not block the target consumer on missing collaboration runtime;
4. evidence epoch decisions are visible in Jangar and Torghut operator surfaces before enforcement begins.

# 63. Torghut Profit Windows and Evidence Escrow Contract (2026-03-21)

Status: Approved for implementation (`discover`)
Date: `2026-03-21`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`

Extends:

- `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
- `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`

## Executive summary

The decision is to stop pricing Torghut's mixed-evidence runtime through one stale-or-not route answer and instead
compile two durable objects: **Profit Windows** and **Evidence Escrows**.

The evidence from `2026-03-21` is explicit:

- `GET http://torghut.torghut.svc.cluster.local/trading/status` at `2026-03-21T00:08:11Z`
  - reports `dependency_quorum.decision="unknown"` with `reasons=["jangar_status_fetch_failed"]`;
  - reports `live_submission_gate.blocked_reasons` including `empirical_jobs_not_ready`,
    `dependency_quorum_unknown`, and `quant_health_fetch_failed`;
  - still cites `quant_evidence.source_url="http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m"`;
  - still holds all three hypotheses in `shadow` or `blocked`.
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - returns `ready=false`;
  - shows all four empirical jobs as `truthful=true` but stale from `2026-03-19T10:31:27Z`;
  - proves the system has evidence artifacts, but not evidence-window ownership.
- `GET http://torghut.torghut.svc.cluster.local/db-check` at `2026-03-21T00:08:42Z`
  - returns `ok=true`, `schema_current=true`;
  - confirms head `0025_widen_lean_shadow_parity_status`;
  - still surfaces migration-parent-fork warnings that should remain visible in trading authority.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - shows `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_signals"} 829`;
  - shows `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_microbars"} 1944`;
  - proves freshness debt is persistent enough to deserve a priced contract rather than a request-time shrug.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 40`
  - shows `torghut-forecast` and `torghut-forecast-sim` continuing to fail readiness with HTTP `503`;
  - shows the live Torghut revision itself still serving.
- `services/torghut/app/trading/submission_council.py`
  - still treats failed quant-health fetch as one blocker in the shared live gate payload.
- `services/torghut/app/trading/hypotheses.py`
  - still loads Jangar dependency quorum from a single generic status URL and reduces it early.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still reads stale or missing forecast/uncertainty inputs at route time instead of through immutable window ids.

The tradeoff is more additive persistence and stricter lane-local accounting. I am keeping that trade because the next
six-month profitability failure will not come from zero evidence. It will come from stale-but-truthful evidence and
fresh-but-partial evidence being flattened into one portfolio-wide stop.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: improve Jangar resilience and safer rollout behavior while defining Torghut architecture that grows
  profitability with measurable hypotheses and bounded guardrails

This document succeeds when:

1. every lane and account can cite one `profit_window_id` plus the `evidence_escrow_id`s it depends on;
2. stale empirical or forecast evidence can freeze only the lanes and windows that require it;
3. route-time gate payloads stop being the only place where evidence freshness, schema warnings, and Jangar truth are
   composed;
4. bounded repair-probe capital is possible only when the active window has the minimum escrow coverage declared by
   the lane book.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is in mixed-evidence mode, not a total outage.

- `/trading/status`
  - returns HTTP `200`;
  - shows `running=true`, `mode="live"`, and `active_capital_stage="shadow"`;
  - proves the runtime can still reason, but not safely promote.
- `/trading/empirical-jobs`
  - shows truthful job artifacts for one candidate and one dataset snapshot;
  - also shows every required job stale, which is evidence-window debt rather than total evidence absence.
- `/db-check`
  - proves database schema parity and lineage readiness;
  - still emits lineage warnings that should be carried into lane authority.
- forecast readiness failures
  - prove some lanes are missing critical inputs;
  - do not by themselves prove that all lanes must be treated the same way.

Interpretation:

- Torghut has enough truth to do better than a portfolio-wide "unknown";
- the missing piece is durable windowed accounting for that truth.

### Source architecture and high-risk modules

The current source tree still keeps too much trading authority in shared request-time composition.

- `services/torghut/app/trading/submission_council.py`
  - the shared gate still turns Jangar fetch failures into one portfolio-wide blocker;
  - there is no durable window id to say which evidence was missing for which lane and for how long.
- `services/torghut/app/trading/hypotheses.py`
  - still reduces Jangar dependency state early and globally;
  - does not preserve lane-specific evidence coverage across a named window.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still consumes forecast and uncertainty artifacts as mutable runtime inputs;
  - cannot yet prove that a trading decision belonged to one immutable evidence window.
- `services/torghut/app/main.py`
  - still projects `/trading/status`, `/trading/health`, and `/readyz` from overlapping runtime reducers;
  - does not emit one profit-window id per lane and account.
- `argocd/applications/torghut/knative-service.yaml`
  - still wires the generic Jangar control-plane status URL into runtime config.

### Database, schema, freshness, and consistency evidence

The data stores are already good enough to support stricter economic contracts.

- `/db-check`
  - proves schema head parity and lineage signatures;
  - shows warnings that should remain attached to windows rather than disappearing behind a green boolean.
- ClickHouse guardrail metrics
  - show repeated fallback totals on freshness queries;
  - prove evidence retrieval cost itself has become a trading input.
- empirical jobs endpoint
  - shows immutable artifact refs and timestamps;
  - proves truthful evidence can still be too old for promotion.

Interpretation:

- the main missing object is not another status field;
- it is an escrow record that says which evidence funded which profit window and which gaps remain unresolved.

## Problem statement

Torghut still has three profitability-killing common-mode behaviors:

1. truthful but stale empirical evidence is treated almost the same as missing evidence in the shared gate;
2. forecast or Jangar fetch failures can dominate route-time authority even when some lanes still have enough fresh
   evidence to remain in bounded shadow or repair-probe mode;
3. expensive or degraded freshness reads show up only as request-time symptoms instead of as durable costs attached to
   a named trading window.

That is too coarse for the next six months. The system needs to know not just whether evidence exists, but whether the
current window is fully funded, partially funded, or unsafe.

## Alternatives considered

### Option A: tighten TTLs and thresholds on the current shared gate

Pros:

- smallest implementation delta;
- may stop stale empirical evidence from lingering as long.

Cons:

- still leaves one shared gate as the common-mode authority path;
- still does not preserve which lane or account was actually missing evidence;
- still gives no durable way to price degraded-but-usable windows.

Decision: rejected.

### Option B: move final profit-window authority into Jangar

Pros:

- one platform-owned source of truth;
- less Torghut-local compiler logic.

Cons:

- couples trading economics too tightly to platform rollout state;
- makes Jangar outages or timeouts more expensive to trading;
- reduces Torghut option value for lane-local experiments and bounded repair probes.

Decision: rejected.

### Option C: profit windows plus evidence escrows

Pros:

- prices evidence freshness, lineage, and retrieval cost explicitly per lane and account;
- allows bounded repair-probe capital only when the active window is partially but acceptably funded;
- preserves strict fail-closed behavior for windows that are underfunded or contradictory.

Cons:

- adds new persistence and projection work;
- requires lane-book and scheduler cutover in stages.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile profit windows per lane and account, then fund those windows with explicit evidence escrows. The
shared route-time gate becomes a consumer of those records instead of the authority compiler.

## Architecture

### 1. Profit windows

Add additive persistence:

- `trading_profit_windows`
  - `profit_window_id`
  - `lane_book_id`
  - `hypothesis_id`
  - `lane_id`
  - `account_label`
  - `window_start`
  - `window_end`
  - `required_escrow_ids_json`
  - `required_firebreak_ids_json`
  - `capital_state` (`shadow`, `repair_probe`, `canary`, `live`, `quarantine`)
  - `capital_cap_bps`
  - `loss_cap_bps`
  - `decision` (`funded`, `partially_funded`, `underfunded`, `expired`, `quarantined`)
  - `reason_codes_json`
  - `issued_at`
  - `expires_at`

Rules:

- the scheduler, `/trading/status`, `/trading/health`, and `/readyz` must all project the same active profit-window
  ids for a lane/account pair;
- a lane may enter `repair_probe` only when its window is `partially_funded` and the missing escrows are explicitly
  allowed by that lane's policy;
- no lane may enter `canary` or `live` on a partially funded or expired window.

### 2. Evidence escrows

Add additive persistence:

- `trading_evidence_escrows`
  - `evidence_escrow_id`
  - `escrow_kind` (`jangar_quant`, `empirical_jobs`, `forecast`, `market_context`, `schema_lineage`, `clickhouse_freshness`)
  - `lane_id`
  - `account_label`
  - `source_ref`
  - `source_url`
  - `artifact_ref`
  - `content_hash`
  - `freshness_seconds`
  - `quality_score`
  - `status` (`funded`, `degraded`, `expired`, `missing`, `quarantined`)
  - `reason_codes_json`
  - `observed_at`
  - `expires_at`

Rules:

- the typed Jangar quant-health route becomes the only valid source for `jangar_quant` escrows after shadow parity;
- truthful but stale empirical jobs remain visible as `expired`, not hidden or treated as fresh;
- schema-lineage warnings and ClickHouse fallback counters are escrow inputs, not silent footnotes.

### 3. Query-cost and freshness contracts

Bounded query firebreaks from March 20 remain, but they now fund or fail escrow directly.

- repeated `freshness_fallback_total` growth or `nan` freshness gauges must produce a degraded or quarantined
  `clickhouse_freshness` escrow;
- forecast `503` must degrade only the windows that declare forecast escrow as mandatory;
- Jangar fetch timeouts must degrade only windows that require fresh Jangar quant escrow and may no longer be hidden
  behind a generic route fallback.

### 4. Measurable hypotheses and guardrails

This architecture is only useful if it improves economic option value safely. The implementation must therefore prove:

1. continuation-style lanes can remain in `shadow` or bounded `repair_probe` when forecast escrow is degraded but their
   mandatory escrows remain funded;
2. event-reversion lanes cannot progress when market-context escrow is stale beyond their declared budget;
3. a lane with expired empirical escrow may remain observable but may not receive live or canary capital;
4. portfolio-wide blocking occurs only when every active lane window is underfunded, not merely because one evidence
   source is degraded.

### 5. Validation and rollout gates

Engineer-stage minimum validation:

1. regression proving `/trading/status`, `/trading/health`, `/readyz`, and the scheduler expose the same active
   `profit_window_id`s;
2. regression proving stale empirical jobs create expired escrow rather than disappearing into a generic gate failure;
3. regression proving forecast `503` degrades only windows that require forecast escrow;
4. regression proving the typed Jangar quant route is mandatory once escrow shadow parity is enabled;
5. regression proving ClickHouse fallback growth or invalid freshness gauges opens degraded or quarantined escrow.

Deployer-stage acceptance gates:

1. shadow-write windows and escrows for one full market session before enforcement;
2. prove lane-book ids, profit-window ids, and escrow ids stay stable across status/readiness/scheduler surfaces;
3. keep live promotion blocked until every candidate lane window is fully funded for one full market session;
4. keep repair-probe capital bounded to the caps declared in the window record.

## Rollout plan

Phase 0. Write-only.

- emit profit windows and evidence escrows alongside the current route-time gate;
- surface them in `/trading/status` and `/trading/health`.

Phase 1. Shadow decisioning.

- compute whether each lane would be funded, partially funded, or underfunded under the new contract;
- compare that to the old shared gate and record mismatches.

Phase 2. Enforce repair-probe and shadow rules.

- allow only bounded `repair_probe` on partially funded windows where the lane policy explicitly permits it;
- keep `canary` and `live` on funded windows only.

Phase 3. Remove generic fallback authority.

- retire generic Jangar status as a valid quant authority input once typed escrow parity is stable.

## Rollback plan

- keep the current shared gate readable during Phases 0-2 for comparison and emergency fallback;
- if window funding diverges materially from observed lane safety, revert capital admission to the prior shared gate,
  keep writing windows and escrows for forensics, and do not delete them;
- if typed Jangar escrow and live route behavior disagree after enforcement, stop promotion, revert to shadow-only
  capital, and reopen the affected windows as `quarantined`.

## Risks and open questions

- partially funded windows can become too permissive if lane policies are vague;
- overly strict escrow expiry could eliminate useful bounded repair-probe learning;
- the system must decide how many window records to retain before compaction without losing economic lineage;
- Jangar and Torghut cutover order matters: typed Jangar escrow must be trustworthy before generic fallback is removed.

## Handoff to engineer and deployer

Engineer handoff:

- add the new window and escrow persistence plus status projections;
- remove generic quant-authority fallback once typed escrow parity is proven;
- add the parity and lane-local degradation tests listed above.

Deployer handoff:

- keep the change shadow-only through one full market session first;
- do not allow any lane beyond `repair_probe` unless its active window is fully funded;
- treat a portfolio-wide block caused by one degraded escrow as a rollback trigger until lane-local funding is proven.

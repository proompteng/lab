# 95. Jangar Torghut Evidence Credit Ladder and Profit Repair Council (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar action admission, rollout failure-mode reduction, Torghut proof repair, swarm stage handoff, and capital
guardrails.

Companion Torghut contract:

- `docs/torghut/design-system/v6/99-torghut-hypothesis-repair-council-and-evidence-credit-ladder-2026-05-05.md`

Extends:

- `94-jangar-proof-backed-rollout-brake-and-repair-debt-ledger-2026-05-05.md`
- `93-jangar-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`
- `docs/torghut/design-system/v6/98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md`

## Decision

I am choosing an **evidence credit ladder with a profit repair council** as the next cross-plane architecture. The
previous proof-feed and repair-dividend work identifies stale proof and ranks repair candidates. The missing operating
rule is how Jangar decides which action classes can spend cluster capacity while Torghut decides which proof repairs are
worth that capacity.

Jangar should mint short-lived `EvidenceCredit` for action classes: `serve`, `discover`, `plan`, `implement`, `verify`,
`zero_notional_repair`, `paper_capital`, and `live_capital`. Credits are not tickets. They are machine-readable
admission receipts derived from current rollout debt, failed AgentRuns, route latency, database proof state, runtime-kit
state, and Torghut repair dividends. A launch or rollout that cannot cite a fresh credit waits. Serving can degrade and
continue. Live capital cannot delay; it is either allowed or blocked.

The tradeoff is that some non-capital work will be throttled even when pods are green. I accept that because the current
failure mode is not simple downtime. It is a mismatch between healthy-looking infrastructure and unprofitable or stale
proof: Jangar status routes time out, live Torghut routes time out or return 502, sim trading only passes in paper mode,
and empirical jobs are missing.

## Evidence Snapshot

All evidence for this pass was read-only.

### Cluster And Runtime Evidence

- The active branch was `codex/swarm-torghut-quant-discover` based on `main`; no local changes existed before this
  design update.
- The Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed the current Jangar pod `jangar-7db87884f4-tsqlr` at `2/2 Running` with
  zero restarts, but events showed rapid rollout churn: recent Jangar app backoff, readiness connection refusals, and a
  Jangar DB readiness probe 500 in the last hour.
- `kubectl get pods -n agents -o wide` showed `agents` and both `agents-controllers` pods ready. The not-ready
  controller replica from the earlier NATS soak had recovered, but failed and long-running Jangar/Torghut AgentRuns
  remained in the recent window.
- `kubectl get jobs -n agents` showed multiple recent failed verify/discover attempts and multiple long-running verify
  jobs, including Torghut discover and verify failures. That is execution debt even though controllers are currently
  ready.
- `kubectl get pods -n torghut -o wide` showed live `torghut-00224` and sim `torghut-sim-00305` at `2/2 Running`; the
  earlier sim ImagePullBackOff had cleared.
- Torghut events still showed live liveness and readiness probe timeouts on `torghut-00224`, repeated ClickHouse
  multiple-PDB warnings, and a keeper PDB with no matching pods.
- Direct Deployment lists, workflow lists, Argo Application reads, and CNPG `pods/exec` database access were forbidden.
  Normal admission logic must use least-privilege route and status evidence.

### Route And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned HTTP 200, but `/api/agents/control-plane/status` timed
  out after eight seconds.
- `GET /api/torghut/trading/control-plane/quant/health` returned HTTP 200 for the default aggregate view with 3,780
  metrics and zero lag; the same route scoped to `TORGHUT_SIM` returned degraded state with zero latest metrics and no
  stages. The aggregate view cannot substitute for account-scoped proof.
- Live Torghut `/healthz` returned HTTP 200 after about 6.5 seconds. Live `/readyz`, `/trading/health`, and
  `/trading/status` timed out after ten seconds; live `/trading/empirical-jobs` later returned HTTP 502.
- Sim Torghut `/readyz`, `/trading/health`, and `/trading/status` returned HTTP 200, but only because the system was in
  non-live paper posture. Sim status showed three hypotheses, zero promotion-eligible hypotheses, three rollback
  required, signal lag around 8,099 seconds, missing empirical jobs, and unknown Jangar dependency quorum.
- `/db-check` on live and sim returned HTTP 200 with current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, one current head, and lineage ready with
  known parent-fork warnings.
- `/trading/empirical-jobs` on sim reported four missing required jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Options catalog `/readyz` returned HTTP 200 but still carried `last_success_ts=null` and a timeout detail. Ready state
  is not enough proof for data usefulness.

### Source And Test Evidence

- `services/jangar/src/server/control-plane-empirical-services.ts` is still a single Torghut status reader that maps a
  failed status read into degraded empirical services.
- `services/jangar/src/server/control-plane-status.ts` is the right aggregation boundary for credits because it already
  combines controller heartbeats, runtime admission, rollout health, watch reliability, execution trust, database
  consistency, and empirical services.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,878 lines and owns the launch-capable schedule
  resources. It must not absorb another large policy block directly; the credit builder should be separate.
- `services/torghut/app/main.py` is 3,981 lines and owns too many machine proof routes. The credit ladder should
  consume compact proof samples rather than add more pressure to the aggregate status route.
- Existing tests cover Jangar control-plane status and empirical services, plus Torghut empirical jobs, submission
  council, DB checks, and trading API payloads. Missing coverage is action-credit computation from mixed evidence:
  healthy pods plus timed-out routes, recovered controllers plus failed AgentRuns, schema-current data plus missing
  empirical jobs, and repair allowed while capital stays blocked.

## Problem

The control plane currently treats too many facts as global health.

That causes avoidable failure amplification. A controller can be ready while the Jangar status route times out. Torghut
pods can be ready while live trading routes time out. Sim can be healthy in paper mode while all hypotheses remain
rollback-required. Database schema can be current while empirical proof is missing. None of those states should be
flattened into "go" or "no-go" for every action.

The system needs an admission currency that is smaller than global health and stricter than ad hoc retries. Jangar
should be able to say:

- serve read paths despite degraded execution trust;
- hold new plan or verify work when recent AgentRun failures consume recovery capacity;
- allow one bounded zero-notional repair when Torghut proves the repair can reduce stale proof;
- block paper and live capital until proof freshness, route health, and dependency quorum all recover.

## Alternatives Considered

### Option A: Tune Timeouts And Probe Windows

Raise Jangar status timeouts, cache Torghut status more aggressively, and widen readiness/liveness windows.

Pros:

- Fastest mitigation for visible timeout noise.
- Reduces false alerts during rollout churn.
- Does not add new objects.

Cons:

- Keeps action admission coupled to broad routes.
- Cannot rank repair work by profit value.
- Makes slow routes look healthier without proving the underlying stale evidence was repaired.

Decision: use tactically, reject as the architecture.

### Option B: Keep Proof Feed And Repair Dividend As Separate Systems

Let Jangar enforce rollout brakes and let Torghut publish repair dividends, but do not introduce shared credits.

Pros:

- Preserves clean ownership boundaries.
- Fewer schema changes.
- Lower implementation risk in the short term.

Cons:

- Jangar still has to guess how much repair capacity to admit.
- Torghut cannot prove that a repair is worth spending a scarce launch when Jangar is degraded.
- Engineer and deployer stages get two audits instead of one acceptance contract.

Decision: reject. Separate ledgers are useful ingredients but insufficient for cross-swarm control.

### Option C: Evidence Credit Ladder With Profit Repair Council

Jangar mints action credits from fresh evidence, and Torghut attaches profit repair dividends to candidate repairs.
Every material action spends the smallest applicable credit.

Pros:

- Reduces failure modes by making action classes explicit.
- Keeps read-serving independent from launch and capital authority.
- Allows repair without opening capital.
- Gives engineer and deployer stages a testable handoff: no fresh credit, no launch.
- Creates an audit path that works without direct database exec access.

Cons:

- Adds a compact cross-plane schema and expiry clock.
- Requires careful shadow rollout to avoid freezing useful work.
- Needs tests in both Jangar and Torghut before enforcement.

Decision: select Option C.

## Architecture

### EvidenceCredit

Jangar materializes a short-lived credit per action class:

```text
evidence_credit
  credit_id
  action_class
  decision: allow | delay | block | brownout
  generated_at
  fresh_until
  evidence_epoch
  debt_reasons
  required_repair_dividend_ids
  route_budget_ms
  max_parallelism
  rollback_trigger
  source_refs
```

Credits expire quickly. Expired credits block launch classes, degrade serving, and block all capital.

### Credit Sources

Credit calculation consumes:

- Jangar pod and DB readiness events;
- controller heartbeat and runtime adapter status;
- failed and long-running AgentRuns;
- runtime-kit availability;
- route health and latency for Jangar status and Torghut proof routes;
- Torghut schema head, empirical job state, hypothesis state, quant health, and options proof state;
- Torghut repair dividends from the companion contract.

### Action-Class Rules

- `serve`: can be `allow` or `brownout` while evidence is degraded.
- `discover`, `plan`, `implement`, `verify`: require low execution debt and a fresh runtime-kit receipt.
- `zero_notional_repair`: may proceed with bounded parallelism when a Torghut repair dividend names the stale proof it
  will reduce.
- `paper_capital`: requires fresh empirical jobs, account-scoped quant health, dependency quorum not blocked, and no
  active rollout debt above threshold.
- `live_capital`: never delays. It is `allow` only after paper-capital evidence passes; otherwise it is `block`.

### Profit Repair Council

The council is not a meeting and not a ticket workflow. It is a deterministic selector that combines Jangar credit
capacity with Torghut repair dividends. It chooses the highest expected proof improvement that fits the current credit
window, or it chooses no launch.

Current candidate classes:

- refresh missing empirical jobs;
- attribute rejected decisions by strategy, symbol, and blocker reason;
- repair options catalog proof so readiness includes a current success timestamp;
- wire account-scoped quant health into Torghut submission council;
- reduce aggregate status route pressure by promoting proof-sample routes.

## Implementation Scope

Jangar engineer stage:

- Add `EvidenceCredit` types and a builder outside `supporting-primitives-controller.ts`.
- Expose credits in control-plane status without enforcement first.
- Add schedule-launch admission hooks that consult credits for plan/verify before other classes.
- Persist or cache source refs so a deployer can explain why a launch was held.

Torghut engineer stage:

- Implement the companion repair council route and dividend scoring.
- Emit proof-sample refs for empirical jobs, rejection attribution, options proof, and quant health.
- Keep all repair actions zero-notional until capital credits pass.

## Validation Gates

- Unit tests for credit decisions from mixed evidence: ready pods plus timed-out routes, failed AgentRuns plus healthy
  controllers, schema-current DB plus missing empirical jobs, and stale options proof.
- Jangar regression test proving serving remains available when plan or verify credit is delayed.
- Supporting-primitives test proving a blocked `verify` credit withholds launch-capable resources.
- Torghut tests proving repair dividends rank the four current repair classes and cannot unlock paper or live capital.
- Read-only staging validation against `/health`, `/api/agents/control-plane/status`, `/db-check`,
  `/trading/empirical-jobs`, `/trading/status`, and account-scoped quant health.

## Rollout

1. Ship credit calculation in shadow mode.
2. Compare shadow credit decisions against one full swarm cadence.
3. Enforce only `plan` and `verify` credits first.
4. Enable `zero_notional_repair` after Torghut dividends are present and tested.
5. Keep paper and live capital blocked until evidence proves freshness, route health, and dependency quorum.

## Rollback

Rollback is configuration-only during the first phases: disable credit enforcement and keep credit calculation visible
for forensics. Existing Torghut capital gates remain unchanged. If the credit builder itself destabilizes status
serving, remove it from the status payload and fall back to the existing runtime admission path.

## Risks

- Credit thresholds may be too strict. Mitigation: shadow mode and per-action enforcement.
- Route evidence may be stale or contradictory. Mitigation: every credit expires and carries source refs.
- Repair dividends can overstate value. Mitigation: zero-notional only until measured debt reduction is observed.
- Controller changes are risky because the supporting controller is large. Mitigation: keep policy in a separate module
  and integrate through narrow admission hooks.

## Handoff To Engineer And Deployer

Engineer acceptance gate: when recent failed AgentRuns and Torghut proof debt are present, Jangar must keep read paths
available, hold plan/verify launch authority, and allow at most bounded zero-notional repair with a cited repair
dividend.

Deployer acceptance gate: after rollout, status must show fresh `EvidenceCredit` ids, action-class decisions, expiry
times, and source refs. Torghut capital must remain blocked while empirical jobs are missing, quant health is not
account-scoped and fresh, or Jangar dependency quorum is unknown.

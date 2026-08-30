# 96. Torghut Control-Plane Proof Feed and Profit Route Budget Contract (2026-05-05)

Status: Accepted for engineer and deployer handoff

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

Torghut should produce a compact **ControlPlaneProofFeed** for Jangar and for its own capital gates. The feed must be
cheaper and more explicit than `/trading/status`: one digest, one freshness clock, route-budget metadata, empirical job
lineage, hypothesis summary, profitability runtime summary, live submission posture, quant-evidence posture, and repair
candidates.

The direct evidence is decisive. The latest live revision can answer narrow routes: `/healthz` is OK, `/readyz` returns
a structured degraded payload, `/db-check` proves the Alembic head is current, `/trading/empirical-jobs` exposes stale
but truthful March empirical jobs, `/trading/profitability/runtime` shows recent decisions and zero executions, and
`/trading/health` reports the current safe capital posture. The monolithic `/trading/status` route timed out after 10
seconds. Jangar still uses that route for empirical services, so it converts a route-budget failure into
`torghut status unavailable` and loses the specific proof details available elsewhere.

I am choosing route decomposition and a materialized proof feed over tuning the status route. Torghut will keep
`/trading/status` for humans and backwards compatibility, but capital-critical and Jangar-critical consumers should read
the bounded feed. The feed does not reopen paper or live capital. It makes the repair queue more profitable by naming
which proof is stale, which evidence is truthful, and which gate would reopen if the repair succeeds.

The tradeoff is an additional producer path. I accept it because a trading control plane should not make profitability
decisions by waiting on a kitchen-sink diagnostic route.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

- `kubectl get pods -n torghut -o wide` showed ClickHouse, Keeper, Symphony, live Torghut, sim Torghut, Alloy,
  exporters, Postgres, options catalog/enricher, Flink job managers, Flink task managers, and websocket pods running.
- Latest live `torghut-00224-deployment-787547645-x4phf` and sim
  `torghut-sim-00305-deployment-6c6d68799c-t2kvc` were both `2/2 Running`.
- Torghut events showed recent live and sim revisions becoming ready, but only after Knative startup and readiness probe
  failures.
- Torghut events also showed repeated ClickHouse multiple-PDB warnings and a keeper PDB with no matching pods.
- Options catalog and enricher pods were running, but recent events still included options readiness HTTP 503 during
  rollout.
- Listing ClickHouseInstallation, FlinkDeployment, Knative Service, and direct pod exec in Torghut was forbidden to the
  agents service account, so the normal assessment path must rely on service-owned read-only routes and exported
  status contracts.

### Route and Data Evidence

- `GET /healthz` on the latest private revision returned `{"status":"ok","service":"torghut"}`.
- `GET /readyz` returned `status="degraded"` with Postgres OK, ClickHouse OK, Alpaca live broker OK, DB schema current,
  empirical jobs degraded, live submission gate blocked by `simple_submit_disabled`, and quant health not configured.
- `GET /db-check` returned `ok=true`, current head `0029_whitepaper_embedding_dimension_4096`, expected head
  `0029_whitepaper_embedding_dimension_4096`, one current head, no missing heads, no unexpected heads, lineage-ready
  state, and known parent-fork warnings.
- `GET /trading/health` returned structured `status="degraded"` with shadow capital, three hypotheses, zero promotion
  eligibility, three rollback-required hypotheses, and dependency quorum blocked by `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned `ready=false`, `authority="blocked"`, and stale jobs
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Each stale job was completed, truthful, persisted as empirical authority, promotion-authority eligible, tied to
  dataset `torghut-full-day-20260318-884bec35`, candidate `intraday_tsmom_v1@prod`, and S3 artifacts under
  `s3://torghut-empirical-artifacts/empirical/sim-proof-884bec35-march18-refresh-20260319-080910/...`.
- `GET /trading/profitability/runtime` returned a 72-hour runtime summary with 8 decisions, 0 executions, 0 TCA
  samples, and rejected decisions for AAPL, AMD, INTC, and NVDA under
  `microbar-volume-continuation-long-top2-v11`.
- `GET /trading/status` timed out after 10 seconds with no body.

### Jangar Consumer Evidence

- Jangar `/health` and `/ready` both served.
- Jangar `/ready` reported healthy runtime kits, including NATS collaboration tooling, but execution trust was
  degraded because the Jangar verify stage was stale.
- Jangar control-plane status reported healthy controller heartbeats, healthy database migration consistency, healthy
  rollout health, and `dependency_quorum.decision="block"`.
- Jangar empirical services still pointed at `http://torghut.torghut.svc.cluster.local/trading/status` and reported
  Torghut status unavailable, even though the latest private Torghut proof routes answered with the exact stale proof.
- Jangar quant-health for Torghut timed out after 8 seconds.

### Source and Test Evidence

- `services/torghut/app/main.py` is too large and too central for Jangar to depend on as a high-frequency proof source:
  3,981 lines covering health, readiness, trading status, profitability runtime, empirical jobs, TCA, market context,
  whitepapers, simulation, and live submission.
- `services/torghut/app/trading/empirical_jobs.py` already returns the right stale/truthful/lineage classification.
- `services/torghut/app/trading/hypotheses.py` already compiles hypothesis-local blockers and promotion state from
  signal lag, feature rows, drift checks, market context, TCA, and Jangar quorum.
- `services/torghut/app/trading/submission_council.py` already enforces typed quant-health URL handling and capital
  stage blocks.
- Existing tests cover empirical job truthfulness, hypothesis dependency quorum, quant-health fetch and endpoint rules,
  trading API payloads, live submission gate route parity, and profitability runtime shape.
- The missing production-quality target is a shared proof-feed compiler with digest parity across health/status/runtime
  routes and a test proving Jangar does not need `/trading/status` to understand empirical proof.

## Problem

Torghut's current route shape makes one expensive route carry too much authority. `/trading/status` is useful for
humans, but it is the wrong dependency for Jangar quorum and future capital automation because it mixes:

- live process status;
- broker and DB readiness;
- market context;
- hypothesis summaries;
- empirical job freshness;
- TCA and profitability evidence;
- quant-health fetches;
- simulation context;
- live submission gates;
- operational metrics.

When that aggregate route times out, the system loses the ability to distinguish "Torghut unavailable" from "status
route over budget" from "empirical proof is stale but truthful." That distinction is the difference between a safe
repair and a blind block.

Profitability is also harmed. Current runtime proof says there were 8 recent rejected decisions and no executions. That
is useful information. It should help choose a zero-notional repair lane. It should not be buried because an unrelated
status aggregation exceeded a timeout.

## Alternatives Considered

### Option A: Keep `/trading/status` as the Authority and Make It Faster

Cache sections, raise timeouts, and keep Jangar pointed at the existing status route.

Pros:

- Minimal API churn.
- Keeps operator behavior familiar.
- Can improve latency quickly.

Cons:

- Leaves Jangar and capital gates coupled to a route that is intentionally broad.
- Makes local performance tuning part of the authority model.
- Fails poorly when one subsection, such as quant-health or market context, is slow.
- Does not produce a digest that can be cited by warrants or repair receipts.

Decision: reject as the architecture. Optimize the route only as a compatibility surface.

### Option B: Let Jangar Read Existing Narrow Routes Separately

Point Jangar at `/trading/empirical-jobs`, `/trading/profitability/runtime`, `/db-check`, and `/trading/health`
directly.

Pros:

- Uses existing routes that answered during this assessment.
- Avoids a new producer initially.
- Gives Jangar better evidence than the monolithic status timeout.

Cons:

- Jangar now owns route fanout and partial-failure composition.
- Route fanout can amplify pressure during degraded windows.
- No single digest or freshness clock exists for capital gates.
- Different consumers may disagree about which route sample was current.

Decision: use as a bootstrap strategy behind the feed, not as the final contract.

### Option C: Materialized Control-Plane Proof Feed

Torghut compiles the existing narrow evidence into one compact feed with a digest and route-budget metadata. Jangar and
Torghut capital gates consume the feed instead of forcing deep request-time status reads.

Pros:

- Separates human status from machine proof.
- Preserves stale/truthful empirical lineage even when `/trading/status` is slow.
- Gives every capital and repair decision a digest and expiry.
- Lets Torghut rank repair value without widening capital.
- Reduces Jangar route fanout and false quorum reasons.

Cons:

- Adds a feed compiler and freshness clock.
- Requires migration and parity tests across existing routes.
- The first implementation may still need short-lived route fanout until the feed is persisted.

Decision: select Option C.

## Chosen Architecture

### ControlPlaneProofFeed Compiler

Add a pure compiler under `services/torghut/app/trading/control_plane_proof_feed.py`. It consumes existing route helper
outputs and emits a compact payload:

```text
control_plane_proof_feed
  schema_version
  generated_at
  fresh_until
  digest
  active_revision
  route_budget
  database_schema
  empirical_jobs
  runtime_profitability
  hypothesis_summary
  live_submission_gate
  quant_evidence
  repair_candidates
  source_refs
```

The compiler should not submit orders, mutate database records, or launch jobs. It composes evidence already owned by
Torghut.

### Route Budget

Every feed includes a budget block:

```text
route_budget
  producer
  budget_ms
  elapsed_ms
  cache_state              # fresh, stale, bypassed, unavailable
  expensive_sections
  timed_out_sections
  fallback_sections
  reason_codes
```

Rules:

- If a subsection misses budget, the feed records that section as unavailable rather than timing out the full response.
- Feed freshness expires faster than capital warrants. A stale feed can support operator diagnosis, but not capital.
- Jangar may treat a feed route timeout as `torghut_proof_feed_unavailable`; it must not infer empirical lineage from a
  missing feed.

### Repair Candidates

The compiler ranks zero-notional repair candidates:

```text
repair_candidate
  repair_kind
  affected_hypotheses
  stale_subjects
  expected_gate_reopened
  expected_net_edge_delta_bps
  proof_cost_budget
  capital_impact           # none, paper_after_validation, live_after_validation
  reason_codes
```

Initial repair candidates from current evidence:

- `empirical_refresh`: stale truthful March jobs can be refreshed against a current dataset or replay window.
- `status_route_budget`: `/trading/status` over budget should be decomposed or cached before Jangar depends on it.
- `quant_health_route`: Jangar quant-health timed out and should be repaired before capital can trust it.
- `signal_or_session_clock`: recent decisions are stale relative to the current date and need session-aware clocking.
- `live_submission_gate`: remains closed by `simple_submit_disabled`; this is expected during proof repair.

### Capital Semantics

The proof feed can improve repair priority. It cannot authorize paper or live capital by itself.

Capital rules:

- Paper capital requires an eligible hypothesis warrant, fresh empirical proof, a healthy or explicitly not-required
  quant-evidence warrant, bounded route budget, and positive post-cost expectation.
- Live capital additionally requires explicit live promotion toggles, broker safety, rollback rehearsal, and Jangar
  capital quorum.
- Stale truthful empirical jobs may create `repair_only`; they may not create `paper_probe` or `live_probe`.
- A feed with `route_budget.cache_state="stale"` cannot widen capital even if all business fields look favorable.

## Implementation Scope

Engineer stage:

- Add `control_plane_proof_feed.py` with a pure compiler and typed payload helpers.
- Add `GET /trading/control-plane/proof-feed` as the new bounded route.
- Reuse existing helpers for DB schema status, empirical jobs, profitability runtime, hypothesis summary, live
  submission gate, and quant evidence; do not duplicate business logic.
- Add digest and freshness calculation.
- Add tests in `services/torghut/tests/test_control_plane_proof_feed.py`.
- Add route tests proving `/trading/control-plane/proof-feed` answers when `/trading/status`-only sections are slow or
  unavailable.
- Keep `/trading/status` backwards-compatible and optionally include the latest feed digest.

Deployer stage:

- Roll out the feed in shadow mode.
- Capture feed route latency, digest freshness, and parity against `/trading/empirical-jobs`,
  `/trading/profitability/runtime`, `/trading/health`, and `/db-check`.
- Enable Jangar shadow consumption before switching Jangar empirical services authority.
- Keep live and paper promotion disabled until feed freshness and warrant parity are stable for the agreed replay or
  market-session window.

## Validation Gates

- Unit tests prove the current stale March empirical jobs compile to `repair_only`, not capital-eligible.
- Unit tests prove a `/trading/status` timeout does not erase empirical job lineage from the feed.
- Unit tests prove DB schema current state and lineage warnings are represented without requiring direct SQL.
- Unit tests prove quant-health not configured and quant-health timeout remain separate reason codes.
- Route tests prove the feed has one digest and a `fresh_until` field.
- Jangar integration smoke proves control-plane status can cite proof-feed evidence while legacy status reader is
  unavailable.
- Manual live validation records `/healthz`, `/readyz`, `/db-check`, `/trading/empirical-jobs`,
  `/trading/profitability/runtime`, `/trading/health`, `/trading/control-plane/proof-feed`, and Jangar status.

## Rollout

1. Ship the pure compiler and route behind a feature flag.
2. Enable the route in shadow mode and publish latency/digest metrics.
3. Add the feed digest to `/trading/status` for operator correlation.
4. Let Jangar read the feed in shadow and compare against the legacy empirical-services reader.
5. Switch Jangar empirical-services authority to the feed once parity shows no capital-widening diff.
6. Use the feed's repair candidates to drive zero-notional repair only.
7. Consider paper probes only after fresh warrants, healthy route budgets, and positive post-cost evidence exist.

## Rollback

- Disable `GET /trading/control-plane/proof-feed` and keep existing routes unchanged.
- Keep any generated feed records or logs for audit, but remove them from Jangar quorum and Torghut capital decisions.
- If the feed ever widens capital from stale evidence, force all affected hypotheses to `hold`, invalidate the digest,
  and require a fresh empirical refresh.
- If the feed route increases DB or ClickHouse pressure, return it to cached shadow mode and narrow the producer set.

## Risks

- The first compiler may accidentally reintroduce the same heavy-route behavior. Route-budget tests must fail if a
  single slow subsection blocks the entire feed.
- Operators may treat `expired_truthful` evidence as better than it is. The payload must spell out that it can rank
  repair but cannot fund capital.
- Least-privilege workers still cannot run direct SQL. That is acceptable for normal assessment only if the feed and
  DB-check route stay honest; otherwise the smallest unblocker is a read-only SQL path or a new service-owned
  diagnostic endpoint.
- Repair ranking can over-focus on empirical refresh while signal/session clocking or quant-health is the real first
  blocker. Repair receipts must record which gate reopened and which gate stayed closed.

## Handoff Contract

Engineer acceptance:

- The PR adds the proof-feed compiler, route, digest, route-budget block, repair candidates, and tests.
- Existing route semantics remain backwards-compatible.
- The feed can represent current evidence: stale truthful empirical jobs, current DB schema, degraded health,
  zero-execution profitability runtime, live submission disabled, and quant-health not configured or timed out.

Deployer acceptance:

- Shadow rollout shows the feed route answers within its budget and matches existing narrow routes.
- Jangar shadow consumption is observed before authority switches.
- No paper or live capital opens during proof-feed shadowing.

Owner acceptance:

- The owner handoff names the active feed digest, stale empirical subjects, route-budget result, first repair
  candidate, and the capital gate that remains closed.

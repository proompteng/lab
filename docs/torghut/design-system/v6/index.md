# Torghut Design System v6: Beyond TSMOM Intraday Autonomy Pack

## Status

- Version: `v6`
- Date: `2026-03-03`
- Maturity: `production-quality design pack`
- Scope: intraday strategy architecture upgrade beyond static TSMOM, with regime-adaptive routing, DSPy-governed LLM reasoning, contamination-safe evaluation, and production rollout controls
- Implementation status: `Mixed` (historical program closure recorded on `2026-03-03`; source-state refreshed on `2026-03-09`)
- Implementation status (strict, core 01-13 docs, source-state refresh `2026-03-09`): `Implemented=7`, `Partial=5`, `Completed=1`
- Evidence (historical closure): `13-production-gap-closure-master-plan-2026-03-03.md` (Wave 0-6 closure + DoD)
- Evidence (current next-work priority):
  - `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
  - `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
  - `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
  - `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
  - `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
  - `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
  - `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
  - `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
  - `44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
- `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- Cross-system source of truth:
  - `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
  - `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
  - `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
  - `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
  - `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
  - `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- Discover stage merge anchor:
  - `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
  - `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- Evidence sync: `14-legacy-gap-disposition-map-2026-03-03.md` (signed v4/v5 disposition completeness)
- Rollout status: v6 pack controls are represented by merged runtime/control-plane closure phases in `main` (`#3921` through `#3960`).

## Current reading order

For current corpus navigation across active contract docs versus historical closeout records, use:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`

## Historical closeout note (2026-03-09)

The March 3 completion record remains useful as a dated closure milestone, but it should not be read as "nothing important remains."

Current source-state priority is narrower:

- deterministic runtime closure is materially landed;
- freshness discovery and proof persistence are still too brittle;
- recurring empirical prove-and-promote automation remains blocked on those truth surfaces.

## Recent Updates

- `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md` now records the landed hypothesis
  governance tables and the proving-lane schema choices.
- `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md` now records the implemented runtime-window and
  capital-stage contract used by the doc29 proof lane.
- `29-code-investigated-vnext-architecture-reset-2026-03-06.md` now includes the doc29 closeout record, the exact
  smoke and full-session replay ids, and the final `9/9` gate-satisfaction result.
- `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md` now distinguishes the March 6 live-state
  baseline from the March 7 implementation closeout, while keeping live promotion as an operator-controlled decision.
- `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md` now anchors the target-state design in the
  actual proof results and the full-session replay profitability nuance.
- `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md` now records the next
  recommendation iteration, updated on `2026-03-09` to reflect source reality: heartbeat-backed dependency quorum,
  manifest validation, persistence, and status surfacing are already in-tree, so the remaining priority is
  authoritative empirical evidence generation plus recurring prove-and-promote automation.
- `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md` now turns that priority into a standalone
  implementation contract that reuses the existing empirical manifest/persistence/status surfaces and makes scaffold
  parity/Janus outputs non-authoritative by design.
- `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md` now replaces query-derived freshness and aggregate
  zero-heavy readiness with a producer-authored control-plane ledger plus hypothesis-scoped proof bundles, grounded in
  the March 14 live state where Jangar freshness queries were memory-bound and Torghut empirical jobs remained absent.
- `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md` now finalizes the discover-to-plan
  transition with explicit segment-scoped rollout design, profitability mesh decision gates, and explicit engineer/deployer
  rollout and rollback handoff expectations.
- `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md` records the latest discover assessment,
  failure-mode evidence, and merged-PR lineage for a concrete handoff from architect to engineer/deployer.
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md` now binds the v6 Torghut lane to the
  March 19 cross-system source-of-truth architecture, replaces mixed promotion vocabulary with
  `observe/canary/live/scale/quarantine`, and makes scheduler/status parity plus options-bootstrap gating explicit.
- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md` now turns the March 19 mixed-state
  runtime evidence into one submission-council contract, lane-local profit cells, and an options bootstrap escrow that
  keeps import-time DB/image failures from masquerading as general profitability truth.
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md` now turns the March 19
  live contradictions into a stricter capital contract: non-observe capital requires an expiring profit reservation,
  a healthy schema witness, and owned simulation-slot capacity.
- `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md` now makes that capital
  contract hypothesis-local: each sleeve carries segment requirements, evidence expiry, overlap caps, and typed
  alert-driven deallocation.
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md` now makes the next step
  explicit: non-observe capital depends on one certificate that consumes Jangar witness quorum, Jangar market-context
  and quant evidence, toggle parity, and typed options auth/bootstrap escrow rather than local gate optimism.
- `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md` now turns incomplete rollout
  evidence into a first-class veto by requiring fresh witness mirrors for rollout, stage health, and consumer
  acknowledgement before Jangar may emit promotion-friendly authority.
- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md` now extends the
  March 19 authority-ledger work by requiring consumer acknowledgement of rollout epochs and by turning Huly transport
  failures into explicit segment circuit breakers rather than implicit fatal preconditions.
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
  now turns segment health into durable control-plane truth with freshness, evidence refs, consumer acknowledgement,
  and replayable collaboration outbox semantics.
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md` now replaces permissive local
  live-gate truth with Jangar-issued promotion certificates, segment-local firebreaks, and explicit engineer/deployer
  acceptance gates for options/data failures.
- `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md` now defines segment-local
  control-plane authority and scoped rollout semantics to prevent watch noise from becoming global rollout blockers.
- `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md` now defines multi-horizon profitability
  lanes, capital-budget-aware progression, and demotion guardrails to move from static safety to measurable profit growth.
- `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md` defines the full architecture merge program that
  binds segment-aware control-plane operations with hypothesis profitability lane governance.
- `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md` now records the
  discover-stage merge contract with evidence and explicit engineer/deployer acceptance gates.
- `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md` now records the production design for a
  separate Alpaca options ingest and TA lane, grounded in the current equity-only Torghut runtime and cluster state.
- `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md` now turns that architecture into explicit event,
  storage, identity, and SLO contracts for implementation.
- `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md` now records the remaining production
  hardening work for the deployed options lane: market-open validation, `opra` shadow promotion, ClickHouse schema
  bootstrap, and options-specific guardrails.
- `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md` now defines the lane-aware simulation,
  replay, and profitability-proof system required before any options strategy can request live capital.
- `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md` now defines the eventual trading-runtime
  integration contract for options signals, pricing, risk, lifecycle handling, and broker execution boundaries.

## Purpose

Translate the "Beyond TSMOM" research synthesis into implementation-grade Torghut designs that can be executed by engineers and AgentRuns with explicit contracts, safety gates, and rollout criteria.

This pack is positioned as the next architecture layer above:

- `docs/torghut/design-system/v5/12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md`
- `docs/torghut/design-system/v5/13-fundamentals-news-codex-spark-agent-pipeline-2026-02-26.md`
- `docs/torghut/design-system/v5/14-dspy-jangar-openai-full-rollout-2026-02-27.md`

## Non-Negotiable Invariants

- Deterministic risk and policy controls remain final authority.
- DSPy review runtime uses Jangar OpenAI-compatible endpoints (`/openai/v1/chat/completions`) with spark model for live LLM inference.
- Legacy runtime network LLM call paths are removed from the decision codepath once cutover is complete.
- Contamination-aware, forward-only evaluation is mandatory before promotion.
- Every promotion and rollback action must be evidence-backed and reproducible.

## Document Set

1. `01-beyond-tsmom-system-architecture-and-latency-model.md`
2. `02-regime-adaptive-expert-router-design.md`
3. `03-dspy-llm-decision-layer-over-jangar.md`
4. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
5. `05-evaluation-benchmark-and-contamination-control-standard.md`
6. `06-production-rollout-operations-and-governance.md`
7. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
8. `08-profitability-research-validation-execution-governance-system.md`
9. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
10. `10-timesfm-foundation-model-router-parity.md`
11. `11-deeplob-bdlob-microstructure-intelligence.md`
12. `12-posthog-agent-observability-and-error-tracking-production-design.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
21. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
22. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
23. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
24. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
25. `23-trading-startup-readiness-warmup-2026-03-04.md`
26. `26-database-migration-lineage-and-readiness-contract-2026-03-05.md`
27. `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
28. `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
29. `29-code-investigated-vnext-architecture-reset-2026-03-06.md`
30. `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md`
31. `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
32. `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
33. `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
34. `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
35. `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
36. `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
37. `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md`
38. `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
39. `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
40. `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
41. `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
42. `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
43. `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
44. `44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
45. `46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`
46. `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
47. `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`
48. `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
49. `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
50. `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
51. `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
52. `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
53. `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`

## Recommended Build Order

1. `05-evaluation-benchmark-and-contamination-control-standard.md`
2. `08-profitability-research-validation-execution-governance-system.md`
3. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
4. `01-beyond-tsmom-system-architecture-and-latency-model.md`
5. `10-timesfm-foundation-model-router-parity.md`
6. `11-deeplob-bdlob-microstructure-intelligence.md`
7. `02-regime-adaptive-expert-router-design.md`
8. `03-dspy-llm-decision-layer-over-jangar.md`
9. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
10. `06-production-rollout-operations-and-governance.md`
11. `12-posthog-agent-observability-and-error-tracking-production-design.md`
12. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
21. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
22. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
23. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
24. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
25. `23-trading-startup-readiness-warmup-2026-03-04.md`
26. `26-database-migration-lineage-and-readiness-contract-2026-03-05.md`
27. `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
28. `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
29. `29-code-investigated-vnext-architecture-reset-2026-03-06.md`
30. `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md`
31. `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
32. `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
33. `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
34. `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
35. `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
36. `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
37. `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
38. `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md`
39. `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
40. `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
41. `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
42. `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
43. `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
44. `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
45. `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
46. `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
47. `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
48. `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`

## Why This Sequence

- Evaluation correctness and contamination safety must be locked first to avoid optimizing to invalid signals.
- Profitability must be treated as an operating system with strict stage contracts from research through governance.
- External benchmark parity should be established before broadening model families and execution intelligence.
- System architecture and routing design define data contracts used by the LLM and alpha-evolution layers.
- DSPy decision integration must be implemented on top of stable routing and deterministic gate interfaces.
- Autonomous strategy evolution should only be promoted after evaluation and serving contracts are stable.
- Production rollout and governance closes with explicit SLO, rollback, and incident controls.
- Live profitability must ultimately be governed by a database-backed hypothesis ledger, not only by static artifacts.
- PostHog observability design is sequenced late to instrument stable runtime paths and avoid telemetry contract churn.
- The hypothesis-led alpha readiness and profit circuit closes the remaining gap between runtime health and capital promotion, ensuring profitable scale-up is evidence-backed instead of inferred from process uptime.
- The code-investigated vNext architecture reset is sequenced last because it reframes the pack around the now-visible
  gap between control-plane completion and empirical alpha readiness, and it defines the contract for the next wave of
  implementation work.
- The live-state disposition comes after the reset because it converts the March 6 designs into an execution order for
  the current cluster and source state, separating what must be maintained from what can safely be implemented next.
- The proven autonomous quant system architecture comes last because it consolidates the earlier v6 work into the clean
  end-state topology: deterministic runtime authority, first-class mirrored simulation, generated empirical evidence,
  and time-gated live promotion.
- The authoritative empirical promotion evidence contract follows the closeout rationale because it translates the
  March 8 recommendation into an implementation-ready boundary around existing empirical manifest, persistence, and
  operator surfaces.
- The freshness-ledger and proof-mesh contract follows that boundary because the next operational problem is no longer
  "what counts as truthful empirical evidence?" but "how do control-plane freshness and per-hypothesis proof stay
  truthful under live load without depending on heavy scans and process-local counters?"
- The control-plane resilience contract now follows the freshness proof mesh because rollout failure modes must become scoped
  and observable before safe capital transitions can accelerate.
- The profitability guardrail architecture follows that resilience contract because safe capital growth is impossible if
  rollout scope is still a single global state channel.
- `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md` introduces explicit mixed-failure decision trees and
  engineer/deployer handoff criteria to complete the joint architecture lane.
- The Alpaca options implementation contract set follows the architecture doc because options ingest is only safe to
  build once the concrete topic, storage, rate-limit, and identity contracts are fixed.
- Options hardening and `opra` promotion follow the implementation contract set because the lane now exists in
  production and must prove real-session behavior before strategy work is resumed.
- The options replay and profitability-proof lane follows hardening because simulation truth depends on a trustworthy
  live data contract and a session-proven production feed.
- The options trading-runtime integration comes last because it is only safe once both the market-data lane and the
  replay/proof lane are authoritative.
- `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md` is now the discover
  stage transition contract with explicit cluster/source/database assessment and rollout/rollback requirements.
- `46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md` and
  `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md` convert the historical discovery stack into
  explicit per-hypothesis and per-lane profitability execution contracts for plan-stage implementation.

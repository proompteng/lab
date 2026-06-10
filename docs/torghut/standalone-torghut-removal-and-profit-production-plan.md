# Production Plan: Remove Jangar Dependencies (Standalone Torghut) + Make Torghut Profitable & Production-Ready

## Context
Torghut (`services/torghut`) is the core FastAPI autonomous trading/empirical/quant service (trading loop, Flink TA via dorvud, ClickHouse signals, Postgres decisions/executions, TigerBeetle runtime ledger, empirical promotion, autonomous lanes, DSPy/LLM review, simulation/replay, hypotheses state, proof floor, etc.). It is deeply coupled to Jangar (`services/jangar`) for:
- External governance/control-plane authority (capital stages, promotion, reentry, repair dispatch/auctions/budgets, custody/leases/escrows, stage clearance, source-serving/rollout verification, evidence pressure, negative-evidence routing, consumer-evidence transport).
- Supporting services: symbols/universe (`JANGAR_SYMBOLS_URL`), market-context bundles for LLM (`TRADING_MARKET_CONTEXT_URL`), quant health (`TRADING_JANGAR_QUANT_HEALTH_URL`), controller-ingestion carry, dependency quorum/verify-trust/repair-slot, continuity packets.
- Surfaces: heavy Jangar-facing endpoints/projections (`/trading/consumer-evidence`, `/trading/revenue-repair`, status/readyz/health enrichments with `torghut.*.v1` compact receipts, ledgers, frontiers, `jangar_*_ref`, `max_notional=0` until Jangar settlement).
- Dispatch: whitepaper/AgentRun via Jangar (or agents fallback with JANGAR_* alias); DSPy runtime over Jangar OpenAI-compatible gateway.
- Config/manifests: pervasive `TRADING_JANGAR_*`, `JANGAR_BASE_URL/API_KEY`, `TRADING_UNIVERSE_SOURCE=jangar` (with require-non-empty), argocd knative-service envs, simulation forcing jangar source.
- Docs: design-system/v1–v6 + rollouts saturated with paired Torghut-Jangar contracts (consumer-evidence family, verification-carry, repair-bid/settlement, alpha-readiness conveyors, profit clocks/leases/frontiers, source-serving, freshness-carry, no-delta reentry, etc.). Current runtime state (from CNPG status, cluster checks, rollouts ~May 2026): "repair_only"/"zero_notional"/"shadow", live_submission_gate closed (`simple_submit_disabled`, `alpha_readiness_not_promotion_eligible`, `runtime_ledger_*_pending`, `empirical_jobs_not_ready`, `post_cost_expectancy_non_positive`), flat cash positions, 17 recent blocked decisions with no attached positive expectancy/sim PnL.

This coupling prevents true autonomy (Torghut as trading+empirical+internal-governance plane), makes readiness fragile (external Jangar down/stale blocks carry/quorum/health/market-context/universe), bloats Torghut with cross-plane "Jangar contract" machinery (many alpha_*/profit_*/repair_*/route_*/evidence_* modules + payloads exist only for Jangar consumption/settlement), and blocks profitability (capital stays gated at 0 until external proofs + Jangar custody align).

**Why now**: User request to (1) completely remove Jangar deps for standalone Torghut (eliminate dead code), (2) make the system profitable and production-ready with an executable path that actually produces profit (target honest ~$500/day post-cost net with strict rules: active/positive day ratios, DD caps, best-day concentration, runtime-ledger + TCA + source-linked empirical proof). Standalone simplifies governance (internalize what was offloaded) and removes external blockers. Profitability requires driving the existing empirical→frontier→paper-runtime-ledger-proof→local-promotion→small-live-capital loop using in-repo scripts/tools while keeping every safety invariant (paper-default, deterministic risk/kill-switches final, zero-notional until gates, GitOps, immutable manifests).

Exploration (read-only via list_dir/grep/read_file + explore subagents) covered:
- services/torghut/app/config.py, main.py, trading/* (jangar_*.py, consumer_evidence.py, revenue_repair.py, market_context.py, hypotheses.py, universe.py, empirical_*, profit_*, runtime_ledger_*, proof_floor.py, alpha_*, autonomy/*, llm/dspy/*).
- scripts/* (run_empirical_promotion_jobs.py, search_*profitability_frontier.py, run_autonomous_lane.py, verify_quant_readiness.py, build_*profitability_proof.py, run_dspy_workflow.py, etc.).
- config/ (autonomous-*.yaml/json, evaluation-gates.json, profitability-frontier-*.yaml, simulation yamls).
- docs/torghut/ (README.md, design-system/* all v*, rollouts/* esp. 2026-05 series + profit-candidate-board, system-design.md, automated-trading.md, llm-review-via-jangar-plan.md, tigerbeetle-*, production-readiness-proof-runbook.md, oracle profit prompt).
- services/jangar/src/server/ (torghut-*.ts modules for consumer-evidence, quant-runtime, market-context, simulation-control-plane, trading-*, whitepapers, etc.; tests; paired control-plane-*).
- argocd/applications/torghut/* (knative-service envs for JANGAR_* / MARKET_CONTEXT, empirical cronjobs/workflows).
- Related: packages/scripts torghut TS, tests co-located.

Current partial state (from prior session cleanups in sim): some early-returns/comments for "standalone" in config/hypotheses/market_context, but full removal + profit execution still required. No execution edits allowed in this plan-mode phase except to this plan file.

## Recommended Approach
**Two coordinated plans executed end-to-end** (phased, safe cutover for removal (inventory, internalize governance, prune dead, defaults to static/local, simplify surfaces); for profitability (drive empirical→paper runtime ledger proof→local promotion→small live with P&L measurement using existing scripts, target $500/day post-cost with strict rules).

**Plan A: Remove all Jangar dependencies + make Torghut standalone (eliminate functionality/dead code)** (4-6 weeks).
- Inventory first (contract + code map already started via exploration).
- Internalize governance (move settlement/repair/capital authority/proof adjudication/consumer surfaces inside Torghut or thin internal control-plane co-component; keep core trading/empirical/autonomous intact).
- Prune defaults/calls/surfaces (static universe default, local quorum/allow for market-context/dependency, direct agents for DSPy/whitepaper, remove or stub Jangar-named payloads/endpoints or make them internal-only).
- Eliminate dead code (unreachable fetch logic, legacy jangar_* modules/payload builders, cross-plane heavy alpha/profit/repair/evidence modules that were for external, argocd/env wiring, docs bloat).
- Update manifests/docs/tests; deprecate then remove.
- Result: Torghut owns its capital stages/promotion/repair internally; no outbound Jangar at runtime for trading authority (Jangar may remain narrowly for orthogonal concerns like general UI/LLM gateway if desired, but Torghut path is decoupled).

**Plan B: Make system profitable + production-ready with executable profit path** (parallel/sequential with A; 6-12+ weeks to first consistent positive P&L, ongoing scaling).
- Leverage existing machinery (empirical promotion, profitability frontiers, autonomous lane, runtime ledger/TigerBeetle, proof_floor, hypotheses promotion, simulation/replay, quant-verify, historical sim).
- Drive the exact blocker closure loop visible in code/docs: empirical jobs truthful + ready (promotion_authority_eligible) → paper runtime with full source-backed runtime ledger (order feed + journal + recon + closed flats + TCA) + positive observed post-cost expectancy at target notional → pass local proof floor / alpha readiness / freshness / tca guardrails → local (post-standalone) promotion to small canary/live capital.
- Use scripts for execution (run_empirical_*, search_*frontier*, run_autonomous_lane, build_*profitability_proof, verify_*, assemble_*ledger_proof_packet, journal_cron, etc.).
- Strict measurable targets (honest ≥$500/day post-cost net per trading day with rules from rollouts/catalog: active/positive day ratios, DD caps 10-15%, best-day share ≤25%, min notional, p<=0.05, market net>0, runtime-ledger + executable replay + shadow parity + fresh empirical + source-linked evidence; no synthetic shortcuts).
- Standalone (Plan A) removes external readiness blocks (quorum/health/market-context/universe) and simplifies internal governance (no more "Jangar custody" requirement).
- Measurement/ops: local /trading/status + snapshots + ledger PnL + TCA; kill-switches/emergency-stop; GitOps promotion; post-deploy readyz accepts "repair_only/zero_notional" during transition but live capital requires full floor pass.
- Ramp: one sleeve first (e.g. intraday-tsmom or microbar-continuation family from recent candidates), small notional, monitor, scale only after proof.

**Overall execution order**: Plan A Phase 0-2 first (decouples and cleans), then interleave with Plan B (use local paths for promotion/capital). Full end-to-end via GitOps PRs + quant-verify gates + historical-sim + live small-canary with P&L readback. Save this plan to docs/ first (as `docs/torghut/standalone-torghut-removal-and-profit-production-plan.md`), then execute per phases. Use existing patterns (autonomy lane, empirical manifests, runtime ledger source authority, proof floor) heavily; no new frameworks.

**Trade-offs considered (but not chosen)**: Keep thin compat shim for external Jangar consumers (rejected for "complete remove"); full rewrite of governance (too risky—reuse empirical/proof/ledger/hypotheses); ignore docs/argocd (must update for production).

## Critical Files to Modify (with reuse notes)
**Core Torghut removal (Plan A)**:
- `services/torghut/app/config.py`: Remove/harden JANGAR_* / MARKET_CONTEXT_* / require_non_empty_jangar (reuse existing `trading_universe_source`, `agents_base_url` for DSPy/whitepaper, static fallback, semiconductor_universe). Existing: model_post_init normalization, feature flags, _validate_trading_source_settings.
- `services/torghut/app/main.py`: Remove jangar imports/builders (`load_jangar_*`, `compact_jangar_*`, `build_jangar_authority_receipt`, revenue_repair/consumer_evidence projections, _load_jangar_dependency_quorum_payload, _consumer_evidence_jangar_*). Simplify status/health/readyz/consumer-evidence/revenue-repair to core local state (reuse build_empirical_jobs_status, build_profitability_proof_floor_receipt, runtime_ledger_*_authority, hypotheses compile, proof_floor). Remove whitepaper "jangar_ui" special case. Existing: _evaluate_trading_health_payload, trading_status, _build_*_payload helpers.
- `services/torghut/app/trading/hypotheses.py`: Remove jangar quorum/fetch/cache (reuse load_hypothesis_registry, resolve_hypothesis_dependency_quorum → local signals from empirical/ledger/continuity; _KNOWN_DEPENDENCY_CAPABILITIES without jangar). Existing: compile_hypothesis_runtime_statuses, JangarDependencyQuorumStatus (rename or keep for compat), hypothesis_registry_requires_dependency_capability.
- `services/torghut/app/trading/market_context.py`: Stub external fetch (reuse evaluate_market_context, MarketContextStatus; default allow when no URL for standalone). Existing: _fetch_bundle, fetch_health.
- `services/torghut/app/trading/universe.py`: Default static (reuse _resolve_from_static / semiconductor_universe; deprecate _resolve_from_jangar or make optional fallback). Existing: UniverseResolver, UniverseCache.
- `services/torghut/app/trading/consumer_evidence.py`, `revenue_repair.py`, `jangar_continuity.py`, `jangar_controller_ingestion_carry.py`: Remove or reduce to no-op local stubs (produce minimal internal receipts only; eliminate heavy v* cross-plane payloads). Reuse local proof/empirical/ledger data.
- `services/torghut/app/trading/llm/dspy_programs/runtime.py` + `dspy_compile/workflow.py` + related: Prefer agents_base_url (remove jangar_base_url requirement in _resolve_dspy_* and llm_dspy_live_runtime_gate). Existing: bootstrap_artifact_hash, AgentRun submission.
- `services/torghut/app/whitepapers/workflow.py`: Use AGENTS_BASE_URL direct (remove JANGAR fallback special-casing). Existing: _submit_agents_agentrun.
- `services/torghut/scripts/`: Clean run_dspy_workflow.py (agents first), run_local_simple_lane_replay.py (no force jangar), build_revenue_repair_digest.py + verify_* (remove jangar carry checks or make optional), update any that hard-require.
- Other trading/* (for dead code elimination): Prune or simplify heavy alpha_evidence_foundry, alpha_*_ledger, profit_* (frontier/leases/repair_settlement), repair_* (bid/ outcome/receipt), route_* (evidence/reacquisition/warrant), evidence_* (receipts/clock_arbiter), submission_council, freshness_carry, etc. (many exist only for Jangar "admission"/"for Jangar consumers"; keep slim internal versions for local proof floor/hypotheses). Reuse: runtime_ledger_source_authority, empirical_jobs, proof_floor.
- `services/torghut/README.md`, `docs/torghut/README.md`, design-system/*, rollouts/*, system-design.md, etc.: Update all Jangar contract refs, consumer-evidence language, "Jangar-facing" to "internal/standalone" equivalents. Remove paired v6 docs references.
- `argocd/applications/torghut/knative-service.yaml` + options ws/configmap + empirical cronjobs: Remove JANGAR_* / MARKET_CONTEXT envs (or set empty); update manifests for standalone.
- `services/jangar/src/server/` (torghut-*.ts, control-plane-torghut-*, tests): Deprecate/remove Torghut-specific quant/control/consumer-evidence/market-context/simulation surfaces (or keep narrow for non-trading concerns). Update torghut-trading.ts, torghut-consumer-evidence.ts, etc.
- Tests: Extend co-located (test_profit_signal_quorum, test_capital_reentry_cohorts, test_metrics, etc.) for standalone paths; remove jangar-specific.

**Profitability execution (Plan B, reuses heavily from above + existing scripts/modules)**:
- `services/torghut/scripts/run_empirical_promotion_jobs.py`, `build_empirical_promotion_manifest.py`, `renew_latest_empirical_promotion_jobs.py`: Drive to "ready"/promotion_authority_eligible + truthful authoritative artifacts (Janus + parity + lineage) from paper windows.
- `services/torghut/scripts/search_profitability_frontier.py` + `search_consistent_profitability_frontier.py`: Frontier sweeps for positive post-cost expectancy + capacity (reuse decomposition, vetoes, exact-replay ledger capture).
- `services/torghut/scripts/run_autonomous_lane.py` + `app/trading/autonomy/lane.py` + gates/policy: Research→gates→paper patch (reuse manifest, gate eval).
- `services/torghut/scripts/build_historical_profitability_proof.py`, `run_archive_backed_profitability_proof.py`, `verify_quant_readiness.py`: Produce "passed" proofs + acceptance (p-value, DD, ratios, runtime evidence).
- `services/torghut/scripts/assemble_runtime_ledger_proof_packet.py`, `journal_tigerbeetle_order_events.py` (cron), `audit_tigerbeetle_runtime_ledger_parity.py`, `verify_tigerbeetle_ledger.py`: Ensure source-backed runtime ledger (order feed + TB journal + recon + closed positions) for promotion-grade.
- `services/torghut/app/trading/empirical_jobs.py`, `empirical_manifest.py`, `hypotheses.py` (promotion_eligible, post_cost_expectancy), `proof_floor.py`, `runtime_ledger*.py` (source authority, POST_COST), `profit_freshness_frontier.py`, `quality_adjusted_profit_frontier.py`: Core for blocker detection + local promotion (reuse build_*_status, compile_*, build_profitability_proof_floor_receipt).
- `services/torghut/app/trading/` (tca.py, costs.py, execution*.py, order_feed.py, simulation.py): For TCA/slippage/execution quality in proofs.
- `config/autonomous-gate-policy.json`, `evaluation-gates.json`, `profitability-frontier-*.yaml`, `autonomous-strategy-*.yaml`: Tune gates for promotion (start strict, relax only after proof).
- `argocd/applications/torghut/`: Empirical cronjobs/workflows (already exist); post-standalone manifests.
- `docs/torghut/rollouts/`, `production-readiness-proof-runbook.md`, `tigerbeetle-ledger-runbook.md`: Update with new local promotion runbook + P&L measurement steps.
- Measurement: position_snapshots (equity/cash), trade_decisions/executions (via CNPG or local), TigerBeetle PnL, /trading/status (local proof floor), TCA metrics.

Existing reusable functions/utilities (with paths; leverage these to avoid reinventing):
- `load_hypothesis_registry`, `compile_hypothesis_runtime_statuses`, `resolve_hypothesis_dependency_quorum` (now local), `JangarDependencyQuorumStatus` (adapt) — `services/torghut/app/trading/hypotheses.py`.
- `build_empirical_jobs_status`, `upsert_empirical_job_run`, parity reports — `services/torghut/app/trading/empirical_jobs.py`.
- `build_profitability_proof_floor_receipt`, proof dimensions (alpha/empirical/target_notional/tca/order_feed) — `services/torghut/app/trading/proof_floor.py`.
- Runtime ledger source authority / POST_COST / promotion-grade checks / assemble packets — `services/torghut/app/trading/runtime_ledger_source_authority.py`, `runtime_ledger.py`, `assemble_runtime_ledger_proof_packet.py`.
- `search_profitability_frontier` / consistent variant (observed_post_cost_expectancy_bps, blockers, exact-replay) — `services/torghut/scripts/search_profitability_frontier.py` + `search_consistent_profitability_frontier.py`.
- `run_autonomous_lane` + gates (research→paper candidate) — `services/torghut/scripts/run_autonomous_lane.py`, `app/trading/autonomy/lane.py` + `gates.py` + `policy_contract.py`.
- `build_historical_profitability_proof` / v4 evaluation (p, DD, ratios, "passed") — `services/torghut/scripts/build_historical_profitability_proof.py`, `app/trading/evaluation.py`.
- `verify_quant_readiness` (DB provenance + artifacts + gates) — `services/torghut/scripts/verify_quant_readiness.py`.
- TigerBeetle journal/reconcile/parity — `services/torghut/app/trading/tigerbeetle_*.py` + `scripts/journal_tigerbeetle_order_events.py`, `verify_tigerbeetle_ledger.py`.
- Order feed ingest/normalize + TCA — `services/torghut/app/trading/order_feed.py`, `tca.py`.
- Simulation/replay for proof (time overrides, windows, source dumps) — `services/torghut/app/trading/simulation.py` + `simulation_window.py`, `scripts/local_intraday_tsmom_replay.py`, `start_historical_simulation.py`.
- Core trading (ingest/decisions/risk/execution/firewall/idempotency/reconcile) — `services/torghut/app/trading/{ingest,decisions,risk,execution,firewall,reconcile}.py` + `scheduler/`.
- Status surfaces (simplify post-removal) — `services/torghut/app/main.py` (trading_status, _evaluate_trading_health_payload).
- Whitepaper/AgentRun direct — `services/torghut/app/whitepapers/workflow.py` (use agents direct).
- Config defaults/validation — `services/torghut/app/config.py` (agents_base_url, static universe).

## Verification Section (End-to-End)
1. **Code/Static**: `bun run --filter @proompteng/backend codegen` (if affected); `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json && ...alpha.json && ...scripts.json`; `bunx oxfmt --check services/torghut`; `uv run --frozen pytest services/torghut -m "not stateful" --cov` (add property/stateful per AGENTS.md for trading core); `go test` if dorvud touched (unlikely).
2. **Manifest/Deploy**: `bun run lint:argocd` (or kustomize/helm equiv); update torghut knative + empirical manifests; `kubectl apply --dry-run` or Argo diff.
3. **Standalone functional**:
   - Deploy with no JANGAR_* / MARKET_CONTEXT envs (or empty); assert starts, hypotheses load (local allow), universe static/semiconductor, market_context allow, no outbound Jangar calls (logs/grep).
   - `/trading/status`, `/readyz`, `/trading/health`, `/trading/consumer-evidence` (if kept internal), `/trading/revenue-repair` return simplified local payloads (no jangar_* refs or "standalone" markers; core empirical/ledger/proof_floor present).
   - Paper/sim lanes: run `scripts/run_local_simple_lane_replay.py` (no jangar force), `start_historical_simulation.py`; assert decisions/ledger/TCA without external.
   - Whitepaper/DSPy: test AgentRun submission via agents direct; DSPy shadow with agents_base_url.
4. **Profitability execution**:
   - Run empirical promotion for a candidate (e.g. via `run_empirical_promotion_jobs.py` + manifest from frontier): assert jobs "ready" + promotion_authority_eligible + truthful artifacts + DOC29 pass.
   - Frontier + proof: `search_*profitability_frontier.py` + `build_historical_profitability_proof.py` → positive post-cost expectancy + "passed" proof (p, DD, ratios, runtime samples).
   - Runtime ledger: paper run with order feed + journal cron + `audit_tigerbeetle_runtime_ledger_parity.py` + `assemble_runtime_ledger_proof_packet.py`; assert promotion-grade source (no _NON_PROMOTION markers, full refs, POST_COST).
   - Local promotion: autonomous lane → paper probe (simple route) → import ledger → re-eval → hypothesis capital_stage advance (use internal proof_floor pass).
   - Small live: flip evaluation-gates + local capital (after all gates); monitor via position_snapshots (equity growth), trade_decisions/execs (CNPG or local), TigerBeetle PnL, tca metrics, /trading/status (no zero_notional blockers for the sleeve).
   - Quant verify: `verify_quant_readiness.py` + `verify_trading_readiness.py` (full chain, artifacts, proof floor not "repair_only", alpha readiness quorum allowing).
   - P&L execution: Target first positive post-cost day/week on live sleeve (read back via snapshots + ledger + TCA; compare vs frontier expected). Use kill-switch if adverse. Historical sim + replay for regression.
5. **Safety/Invariants**: Paper default preserved; live requires explicit enable + proof; kill-switches/emergency-stop fire; GitOps changes; full source-linked evidence (no fakes); rollback via revision/artifact; CI gates (pyright all profiles, oxfmt, tests, argocd lint, k8s manifests).
6. **Docs/Plan save**: After writing this plan.md (session), copy contents (or the file) to `docs/torghut/standalone-torghut-removal-and-profit-production-plan.md` (first step in execution). Update cross-refs in README/current-source-of-truth.
7. **End-to-end signoff**: Successful small-live sleeve with measurable +$X post-cost (target $500/day rules), no Jangar in torghut runtime path (grep, manifests, logs), all CI green, updated docs/runbooks, Argo healthy.

**Rollback**: Re-pin prior image/manifest (GitOps); feature flag re-enable legacy jangar paths temporarily; dual-write evidence during transition for parity checks.

**Risks/Mitigations**: Over-removal of useful receipts (keep slim internal); external consumers of old surfaces (document deprecation, one release compat); governance strictness (internal gates can be tuned post-proof but start from existing v3/policy); data volume for empirical (use existing replay/historical sim harnesses).

This plan is derived directly from exploration (no speculation); executable with existing code + minimal new internal governance wiring. Save to docs/ first, then phase-by-phase PRs + verification gates.

## Execution Notes (for after plan approval)
- Use `search_replace` / edits only on listed files.
- Spawn explore subagents if more discovery needed during execution.
- Track in todos (e.g. via todo_write).
- After standalone, profitability uses purely local paths.
- "Executes with profit": first measurable positive post-cost P&L on promoted live sleeve, then scale.

(End of plan. Written via search_replace to session plan.md as required; will be saved to docs/ per user request in execution phase.)
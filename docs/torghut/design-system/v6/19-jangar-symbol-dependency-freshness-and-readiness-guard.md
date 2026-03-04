# 19. Jangar-Authoritative Universe Freshness and Readiness Guard (2026-03-04)

## Context

- Cluster events in `torghut` show readiness and liveness pressure with repeated dependency-related pod restarts during rollout windows, plus repeated transition warnings from the service-level controller.
- Runtime logs for the active pod show repeated `Failed to fetch Jangar symbols` warnings and `Signal freshness alert` messages, while trading cycles are often skipped due to no usable signals.
- Source review shows universe resolution is already cached in `services/torghut/app/trading/universe.py`, but fallback semantics and operator observability vary by code path and can be hard to operate consistently during incident windows.
- Database/surface review shows no immediate schema violations but highlighted the absence of a hard-coded “dependency freshness SLO” contract for runtime symbols and no regression test that locks the failure-mode semantics across all consumers.

## Design Decision

Adopt a dedicated `Dependency Freshness and Readiness` design for Jangar-backed trading universe resolution that makes failure behavior explicit and observable while preserving graceful degradation.

### Selected approach

- Keep Jangar as the authoritative symbol source for live trading/autonomy.
- Introduce a single resolution contract around `UniverseResolution` reason codes:
  - `jangar_fetch_ok`
  - `jangar_cache_hit`
  - `jangar_fetch_failed_using_stale_cache`
  - `jangar_fetch_failed_cache_stale`
- Treat stale cache as a governed, time-bounded degraded mode with a hard transition to blocked mode only when stale age exceeds `TRADING_UNIVERSE_MAX_STALE_SECONDS`.
- Expose a dedicated readiness signal that reflects this contract before enabling critical trading phases.
- Standardize warnings so repeated Jangar fetch failures do not create unbounded noisy log spikes when upstream is temporarily unavailable.

## Implementation Plan (proposed in current branch)

1. Add explicit freshness policy comments and examples in `services/torghut/app/trading/universe.py` around `_resolve_from_jangar()` and `_fallback_from_cache()`.
2. Add an explicit readiness dependency field in trading health payloads consumed by `/trading/health` so the operator can observe when trading is degraded for universe staleness.
3. Add a narrow set of tests under `services/torghut/tests/test_universe.py` for:
   - cached fallback window acceptance versus rejection by age,
   - stable empty-symbol reason transitions,
   - stale-cache warnings not causing hard failure when within policy.
4. Add a rollout validation note in `docs/torghut/design-system/v6/18-trading-readiness-and-rollout-stability-2026-03-04.md` and align readiness checks in operations runbooks.
5. Close with ADR update + risk register entry once green checks pass and cluster smoke validates the new behavior.

## Alternatives Considered

- **Option A (Selected): Keep authoritative Jangar path, but encode explicit freshness SLO + readiness-aware degraded mode.**
  - Pros: Maintains data-lineage integrity while limiting unexpected blank-market behavior under temporary dependency outages.
  - Cons: Requires careful tuning of staleness and alert thresholds for each deployment environment.

- **Option B: Force static fallback if Jangar fetch fails.**
  - Pros: Avoids trading pauses when Jangar is briefly unavailable.
  - Cons: Introduces symbol-set divergence risk that can drift from live governance and reduce strategy determinism.

- **Option C: Fail hard immediately on any Jangar fetch failure and skip cycles.**
  - Pros: Strong safety and strict authority.
  - Cons: Increases stop/start churn and amplifies rollout risk during transient network incidents.

## Tradeoffs

- Strongest operator visibility and governance come from explicit readiness-level metadata, not silent cache reuse.
- Degraded mode provides continuity for short outages but requires disciplined alerting to avoid long-running stale behavior.
- Static fallback has the highest continuity but the weakest scientific and operational correctness for symbol set provenance.

## Risks

- Incorrect threshold tuning could allow stale universe behavior longer than intended.
- If alerting/metric surfaces are incomplete, degraded mode could hide before an SLO breach and delay response.
- If schema consumers assume non-empty symbols in all cases, any forced degraded transition must be gated consistently in scheduler and reporting layers.

## Validation Criteria

- Unit tests cover fresh fetch, cached fallback within policy, stale cache hard-refuse, and empty payload handling.
- `/trading/health` and readiness probes surface explicit universe freshness state.
- Rollout event checks in `torghut` show fewer avoidable readiness oscillations after Jangar network recoveries.

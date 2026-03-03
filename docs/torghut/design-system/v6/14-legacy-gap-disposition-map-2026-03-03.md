# Legacy Gap Disposition Map (v4/v5 -> v6)

## Status

- Doc: `v6/14`
- Date: `2026-03-03`
- Scope: authoritative disposition for unresolved v4/v5 rows referenced by the v6 production gap-closure master plan.
- Disposition status: `Signed`

## Disposition rules

Each unresolved legacy row is assigned exactly one disposition:

1. `Absorbed by v6 implementation`
2. `Deferred with explicit business rationale and date`
3. `Dropped with supersession rationale and risk signoff`

## Signed disposition table

| Legacy row | Legacy status | Disposition | Mapping / rationale | Evidence anchor | Decision date |
| --- | --- | --- | --- | --- | --- |
| `v4/01-time-series-foundation-model-routing-and-calibration.md` | Partial | Absorbed by v6 implementation | Covered by Wave 3 regime/router controls + Wave 5 TimesFM parity contract. | `v6/10`, Wave 3 + Wave 5 closure artifacts | `2026-03-03` |
| `v4/02-limit-order-book-intelligence-and-feature-stack.md` | Not Implemented | Absorbed by v6 implementation | Closed by DeepLOB/BDLOB production contract rollout and fail-closed promotion checks. | `v6/11`, Wave 5 deliverable 2 evidence | `2026-03-03` |
| `v4/03-event-driven-synthetic-market-and-offline-policy-lab.md` | Not Implemented | Deferred with explicit business rationale and date | Research-heavy synthetic market lab is deferred while production governance hardening completes. | Revisit after Wave 6 ops hardening milestone | `2026-05-15` |
| `v4/04-latency-and-inventory-aware-market-making-policy.md` | Not Implemented | Deferred with explicit business rationale and date | Market-making lane expansion deferred until current equity execution safety SLOs sustain target window. | Requires dedicated MM policy track and simulation budget | `2026-05-15` |
| `v4/05-conformal-uncertainty-and-regime-shift-gating.md` | Not Implemented | Absorbed by v6 implementation | Closed by profitability + regime/uncertainty runtime gate enforcement in Waves 1 and 3. | `v6/08`, `v6/07`, autonomy policy checks | `2026-03-03` |
| `v4/06-robust-portfolio-optimization-and-regime-allocation.md` | Not Implemented | Deferred with explicit business rationale and date | Advanced optimizer variants deferred until benchmark parity and live drift controls complete sustained operations. | Requires dedicated allocator research wave | `2026-05-15` |
| `v4/07-llm-multi-agent-trade-committee-and-critic.md` | Not Implemented | Absorbed by v6 implementation | Closed by DSPy live cutover + deterministic veto telemetry lineage in Wave 2. | `v6/03`, Wave 2 closure evidence | `2026-03-03` |
| `v4/08-financial-rag-and-time-series-memory-architecture.md` | Not Implemented | Absorbed by v6 implementation | Closed by Wave 6 observability lineage and correlation contract hardening. | `v6/12`, runbook + readiness evidence package checks | `2026-03-03` |
| `v4/09-ai-market-fragility-and-stability-controls.md` | Not Implemented | Deferred with explicit business rationale and date | Additional fragility-model expansions deferred; current allocator fragility controls already enforce fail-closed posture. | Existing fragility metrics + follow-on roadmap | `2026-05-15` |
| `v4/10-profitability-evidence-standard-and-benchmark-suite.md` | Not Implemented | Absorbed by v6 implementation | Closed by profitability-stage manifest + benchmark parity fail-closed contracts. | `v6/08`, `v6/09`, Wave 1 and Wave 4 evidence | `2026-03-03` |
| `v5/03-microstructure-execution-intelligence.md` | Not Implemented | Absorbed by v6 implementation | Closed by DeepLOB/BDLOB contracts and execution advisor fallback governance gates. | `v6/11`, Wave 5 deliverables 2 and 3 | `2026-03-03` |
| `v5/04-llm-multi-agent-committee-with-deterministic-veto.md` | Not Implemented | Absorbed by v6 implementation | Closed by Wave 2 DSPy-only runtime and deterministic committee/veto telemetry. | `v6/03`, Wave 2 closure evidence | `2026-03-03` |
| `v5/05-fragility-aware-regime-allocation.md` | Not Implemented | Deferred with explicit business rationale and date | Additional fragility allocations deferred until Wave 6 model-risk package drill cadence stabilizes. | Requires new allocator research scope | `2026-05-15` |
| `v5/06-whitepaper-technique-synthesis.md` | Not Implemented | Dropped with supersession rationale and risk signoff | Superseded by v6 production design docs and implemented governance contracts; no direct production runtime target remains. | `docs/torghut/design-system/v6/**` | `2026-03-03` |
| `v5/07-autonomous-research-to-engineering-pipeline.md` | Not Implemented | Absorbed by v6 implementation | Closed by Waves 0-2 strict artifact promotion contracts and governance traces. | `v6/13` Waves 0-2 evidence | `2026-03-03` |
| `v5/08-leading-quant-firms-public-research-and-systems-2026-02-21.md` | Not Implemented | Dropped with supersession rationale and risk signoff | External benchmark inspiration doc is superseded by explicit v6 benchmark parity contract implementation. | `v6/09` + parity gate enforcement tests | `2026-03-03` |
| `v5/09-fully-autonomous-quant-llm-torghut-novel-alpha-system.md` | Not Implemented | Absorbed by v6 implementation | Profitability OS + governance control-plane closure provides deterministic production equivalent. | `v6/08`, `v6/13` | `2026-03-03` |

## Signoff

- Runtime owner signoff: `Torghut oncall owner` (`2026-03-03`)
- Risk/governance signoff: `Quant risk owner` (`2026-03-03`)
- Program signoff condition: all listed legacy rows have explicit disposition and evidence anchor.

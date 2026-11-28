# Bayn cleanup and deprecation audit

## Wave 19Z: Unreferenced code removed

Audited against `aa0a2d91f1f20dca27e59634655311676f26d102`. This cleanup does not change the strategy selector,
activation, wire schemas, or historical evidence.

Paths below are relative to `services/bayn/`. The only references to these three benchmark entry points outside
their own files were rows in the [dated system inventory](evidence/2026-11-08-system-inventory.json). Those rows
record the files at an earlier revision; they are not commands or source locks. The benchmarks were not exported,
invoked by build or CI, used by tests, or bound by a research receipt by path or digest. Their original revisions
remain the reproduction boundary for the performance comparisons.

| Deleted tool                                 | Original comparison                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `tools/benchmark-equity-clock-projection.ts` | Quote-heavy session-clock comparison against a separately bundled projection. |
| `tools/benchmark-normalization.ts`           | Synthetic broker snapshot normalization before and after binding indexing.    |
| `tools/benchmark-staged-inference-cost.ts`   | Staged inference cost handoffs against a separately bundled baseline.         |

A TypeScript export inventory and repository-wide symbol searches found no caller for the following declarations,
including in tests, fixtures, and tools. Only the listed declarations and imports used solely by them were removed.

| File                                         | Removed declarations                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| `src/intraday-replay/alpha-baseline.ts`      | `makeReplayAlphaTrailingBaseline`                              |
| `src/observe-composition/execution-cycle.ts` | `readUnfinishedMutationCycle`                                  |
| `src/execution/runtime-program.ts`           | `ProtectionCancelOutcome`                                      |
| `src/jev/account-protection.ts`              | `AccountProtectionInputs`                                      |
| `src/jev/chart-checkpoint.ts`                | `ChartDispatchClaim`, `ChartTerminalReceipt`                   |
| `src/jev/decisions.ts`                       | `DecisionsInference`                                           |
| `src/jev/experiment-economics.ts`            | `JevEconomicRegistration`                                      |
| `src/jev/staged-checkpoint.ts`               | `StagedSkipReceipt`                                            |
| `src/market-data/sip/provenance.ts`          | `SipBar`, `SipTrade`                                           |
| `src/system-assessment/source-cut.ts`        | `StrategyBoundSystemSourceCut`, `PreparedAlphaSystemSourceCut` |
| `tools/pure-etf-dual-horizon-data.ts`        | `CanarySession`                                                |
| `tools/weekly-attribution-receipts.ts`       | `PortfolioOutcome`                                             |

### Remaining deprecation items

- Recovery uses `readUnfinishedMutationCycles`, including its `readOldestUnfinished` fallback. Retained replay
  still uses the alpha baseline source selection and its existing fail-closed checks.
- Alpaca's deprecated `order_type` field is still accepted alongside the canonical `type`. The broker normalizer
  and its tests require the two to agree when both are present; retire the alias only after the provider contract
  no longer needs it.
- All six files under `scripts/` still have callers. The Nix image consumes `copy-runtime-dependencies.mjs`, the
  package runs `retained-jev-node.test.ts`, and the integration drivers and result verifiers are exercised by
  CI. Documented benchmarks and frozen replay inputs (including dynamically loaded sources) remain.
- Standalone ETF retirement is still conditional on withdrawing the separate activation or rollout contract.
  The momentum and alpha contracts remain needed for migration replay and retained evidence. See the Wave 13F
  dispositions below; this wave does not retire a strategy or a historical policy version.

## Wave 13F: Strategy and evidence audit

Audited against `1894542123c9254e1703c8ee3b082f2c91415f49` and the proposed
[Pure-ETF v3 cutover #16395](https://github.com/proompteng/lab/pull/16395) at
`6fd8e2bae78ea5e8cff3c6e93b232321a42c7a52`. This is a source audit, not a rollout or
confirmation that any account is flat.

### Frozen evidence and tools

This inventory describes the Wave 13F checkout. For subsequently pruned rejected studies, use the historical
checkout linked in each study report to resolve archived source paths and full results. Active evidence and
its source locks remain in place.

The 40 committed `freeze.json` and `results.json` under [evidence](evidence/) were checked before editing tools.
They and the crypto correction identify 73 protected tool paths, including aggregate source locks. No protected
path, its tool imports, or evidence receipt changed in this wave.
Protect a source path even when its current bytes no longer match an older receipt. A search for only
`services/bayn/tools/` misses relative paths, bare filenames, `[filename, digest]` tuples and digest-only bindings:

- The [RVOL/ORB freeze](evidence/2026-11-27-3yr-sip-62sym-rvol-orb-etf/freeze.json) uses `./` paths,
  [Sleeve 4](evidence/2026-11-27-orthogonal-sleeve4/freeze.json) uses bare filenames, and
  [SIP Bayn21 v2](evidence/2026-11-27-3yr-sip-bayn21-v2/freeze.json) uses source tuples.
- For `sourceSha256` in the [crypto freeze](evidence/2026-11-27-3yr-crypto-24x7-trend/freeze.json) and its
  [correction](evidence/2026-11-27-3yr-crypto-24x7-trend/freeze-correction.json), follow
  `sourcePaths` and `sourceDigest` in `tools/research-3yr-crypto-24x7-trend.ts`. For `engineSha256` in the
  [daily-alpha freeze](evidence/2026-11-27-5yr-daily-overnight-alpha/freeze.json), follow `fingerprinted` in
  `tools/research-5yr-daily-overnight-alpha.ts`. Match digest-only replay and diagnostic bindings to their original
  source revisions as well.
- The [eight-year freeze](evidence/2026-11-27-8yr-unseen-intraday-oos/freeze.json) locks the protocol, not the
  archive and statistics adapters. The published scoring revision remains the historical reproduction boundary.
  The Wave 6C and 8A reports pin inputs and upstream revisions; retain their distinct registered resampling conventions.

Use explicit imports from `tools/research-lib/` for new or unpinned work:

- [`s3-archive.ts`](../../services/bayn/tools/research-lib/s3-archive.ts) binds authenticated reads to
  `agents-artifacts`, verifies SHA-256 before decoding metadata, and verifies compressed bytes (including any
  registered non-gzip suffix) and optional decoded-byte receipts before returning a tape result. Validate the
  decoded metadata and admitted universe before opening bars; do not publish from a partial stream.
- [`calendar.ts`](../../services/bayn/tools/research-lib/calendar.ts) normalizes provider sessions, including
  early closes and DST. Require the same ordered dates before pairing paths. Use exact endpoints and counts for
  registered folds; use an inclusive date range only where the protocol permits non-session endpoints.
- [`statistics.ts`](../../services/bayn/tools/research-lib/statistics.ts) owns daily return measures and seeded
  circular stationary resampling. Keep paired Sharpe difference distinct from the Sharpe of daily excess returns.
  Do not change frozen seeds, summation order, bootstrap family, or the benchmark's paired dates.

Wave 13F deleted only `benchmark-report-transport.ts` (single-fixture worker transport experiment) and
`benchmark-report-volume.ts` (synthetic comparison requiring a separately bundled baseline). Neither had an
import, invocation, document reference, or evidence reference by name or content digest in the audited tree.
Tests discovered by Bun are callers in their own right. The frozen-control scenario and its test-support module
are both used by `tools/test-frozen-control.ts`; neither is orphaned. The documented financial/streaming benchmarks
and research inputs also remain.

### Strategy callers and cutover disposition

Paths below are relative to `services/bayn/`; file lists under a directory prefix name its direct importers.
The active strategy selector is `src/strategy.ts`. #16395 switches the selector within **intraday-alpha**, not
to either standalone ETF directory. No strategy directory is unconditionally safe to delete at that merge.

#### `etf-noise-area/`

- **External code callers:** none. Internally, `signals.ts` imports `policy.ts`; `exit-plan.ts` imports both.
- **Tests:** `policy.test.ts`, `signals.test.ts`, and `exit-plan.test.ts` exercise its independent policy and
  planner. #16395 changes its policy test to verify the retained v2 identity instead of asserting that v2 is active.
- **After #16395:** the only cutover-related directory retirement candidate, **if** the separate standalone v1
  activation is withdrawn. The [activation runbook](etf-noise-area-activation.md) still links all three modules
  and describes a distinct planner and six-ETF preset. Archive its links to the original revision and preserve
  the retained v2 identity assertion before removing the three source files and colocated tests. Do not delete
  it just because the v3 entry universe overlaps.

#### `intraday-momentum/`

- **Code callers:** `migrations/0056_intraday_strategy_cutover.ts` uses the decision behavior hash and protocol.
  `src/intraday-replay/{control-portfolio,execution-core,signal-study}.ts` and
  `src/strategy/repeated-momentum/signals.ts` retain the computation. `src/observe-composition/candidate-observation.ts`,
  `src/shadow-decision-contract.ts` and `src/strategy/runtime-decision.ts` retain observation/target contracts.
- **Tests and fixtures:** local `decision-core.test.ts`, `decision.test.ts`, `test-support.ts`;
  `src/strategy/{intraday-market.test.ts,intraday-alpha/test-support.ts}`;
  `src/testing/{candidate-observation-fixture,historical-streaming-fixture,jev-market-fixture,registered-replay-fixture,streaming-market-fixture}.ts`;
  `tools/fixtures/frozen-control-scenario.ts.txt`.
  Other direct test imports:
  - `src/`: `execution-model.test.ts`, `execution-session.test.ts`, `observe-composition.test.ts`,
    `shadow-decision.test.ts`.
  - `src/cycle/`: `recovery.test.ts`, `store/integration.test.ts`, `store/observability.integration.test.ts`.
  - `src/db/`: `jev-native-entry-receipts-postgres.integration.test.ts`, `jev-native-entry-replay-postgres.integration.test.ts`,
    `jev-native-exit-postgres.test-support.ts`, `jev-native-position-postgres.integration.test.ts`,
    `jev-position-protection-evidence.integration.test.ts`, `native-equity-short.integration.test.ts`.
  - `src/execution/`: `intent-pricing.test.ts`, `intents/blocked-cycle-postgres.integration.test.ts`.
  - `src/intraday-replay/`: `conformance.test.ts`, `control-portfolio.test.ts`, `execution-core.test.ts`,
    `ledger.property.test.ts`, `ledger.test.ts`, `runtime.test-support.ts`, `signal-study.test.ts`.
  - `src/jev/`: `available-history.test.ts`, `exit-document.test-support.ts`, `exit.test.ts`,
    `native.test-support.ts`, `runtime.test.ts`, `short-entry.test.ts`, `signal-price-precision.test.ts`.
  - `src/market-data/streaming/`: `bar-publication.test.ts`, `historical.test.ts`, `strategy-replay.test.ts`.
  - `src/observe-composition/position-protection-interpreter.test.ts`;
    `src/system-assessment/{control-definition,retained-v37-held-controller}.test.ts`.
- **After #16395:** retain. Removing even the old decision entry point breaks migration replay or retained evidence;
  v3 does not replace its protocol, target schema or signal math.

#### `repeated-momentum/`

- **Code callers:** `src/strategy.ts`, `src/shadow-decision-contract.ts`, `src/cycle/runner/pass-observation.ts`,
  `src/db/candidate-observation-postgres.ts`, `src/jev/retained-jev-control-targets.ts`,
  `src/strategy/{funded-exit-plan,runtime-decision}.ts`, and
  `src/observe-composition/{candidate-observation,startup}.ts`.
  `src/intraday-replay/{backtest,control-portfolio,control-ridge,control-study,decision-builder,matched-entry-study,native-policy,signal-study,strategy}.ts`
  and `src/system-assessment/{latency-replay,policy,replay-image,strategy-binding}.ts` use retained evaluation,
  protection or policy identity. In particular, `decision-builder.ts` calls the old `runtime.ts`; it is not test-only.
- **Tests:** local `decision.test.ts` and `runtime.test.ts`; `src/composition/native-execution-runtime.test.ts`,
  `src/cycle/store/integration.test.ts`, `src/intraday-replay/{decision-latency.test.ts,runtime.test-support.ts}`,
  `src/jev/{control-document.test-support.ts,signal-price-precision.test.ts}`, and
  `src/system-assessment/{fixtures.test-support.ts,historical-registration.test-support.ts,strategy-binding.test.ts,strategy-registration.test-support.ts}`.
- **After #16395:** retain. A later removal must retire the historical control/replay and target contracts explicitly,
  not infer that they are unused from the absence of an active momentum selector.

#### `intraday-alpha/`

- **Code callers:** `src/{application-plan,shadow-decision-contract,strategy}.ts`;
  `src/cycle/runner/pass-observation.ts`; `src/db/{alpha-baseline-preparation-postgres,candidate-observation-postgres}.ts`;
  `src/forward-performance/{alpha-decisions,postgres/alpha-decisions}.ts`;
  `src/intraday-replay/{alpha-baseline,alpha-prepared-baseline,alpha-report,backtest,native-policy,strategy}.ts`;
  `src/jev/exit.ts`;
  `src/observe-composition/{alpha-baseline-preparation,candidate-observation,decision-builder,entry-observation,execution-window,startup}.ts`;
  `src/strategy/{funded-exit-plan,runtime-decision}.ts`;
  `src/system-assessment/{alpha-observation-witness,capture-queries,latency-report,native-decision-latency,source-cut,strategy-binding}.ts`.
  - `tools/`: `analyze-intraday-alpha-cost-cohorts.ts`, `audit-intraday-alpha-session.ts`, `daily-alpha-data.ts`,
    `execution-microstructure-{cohort,data}.ts`, `intraday-alpha-session-postgres.ts`, `live-profitability-audit-{core,postgres}.ts`,
    `midday-research-{data,execution,signal}.ts`, `multi-horizon-scorecard-{core,receipts}.ts`,
    `portfolio-research-{data,replay}.ts`, `research-execution-microstructure.ts`, `research-midday-beta-neutral.ts`,
    `research-orb-zab-{data,multiyear,protocol,simulation}.ts`, `research-orthogonal-sleeve4.ts`,
    `research-portfolio-allocator.ts`, `research-sleeve4-sip-reference.ts`, `sip-bayn21-{data,replay,statistics}.ts`,
    `sleeve4-signals.ts`, `verify-intraday-alpha-replay.ts`.
- **Tests:** local `intraday-alpha.test.ts`, `policy-v2-1.test.ts`, `portfolio-allocator.test.ts`,
  `stock-in-play.test.ts`, `trailing-exits.test.ts`, `alpha-decision.test-support.ts`, and `test-support.ts`.
  Other direct test imports:
  - `src/forward-performance/alpha-attribution.test.ts` and `src/strategy/etf-noise-area/policy.test.ts`.
  - `src/intraday-replay/`: `alpha-baseline-use.test-support.ts`, `alpha-baseline.test.ts`,
    `alpha-prepared-baseline.test-support.ts`, `alpha-prepared-baseline.test.ts`, `alpha-replay.test-support.ts`,
    `alpha-report.test.ts`, `backtest.integration.test.ts`, `decision-builder.test.ts`.
  - `src/observe-composition.test.ts`; `src/observe-composition/{alpha-baseline-preparation.test-support.ts,closing-market-data.test.ts,entry-alpha-preparation.test.ts}`.
  - `src/system-assessment/`: `alpha-baseline-witness.integration.test.ts`,
    `alpha-observation-witness.integration.test.ts`, `alpha-observation-witness.test.ts`, `native-alpha-latency.test-support.ts`,
    `native-alpha-report.test.ts`, `native-alpha-submission-latency.test.ts`, `prepared-alpha-report.test-support.ts`,
    `prepared-alpha-report.test.ts`, `strategy-binding.test.ts`, `strategy-latency-replay.test.ts`,
    `strategy-registration.test-support.ts`.
  - `tools/`: `analyze-intraday-alpha-cost-cohorts.test.ts`, `audit-intraday-alpha-session.test.ts`,
    `live-profitability-audit-{core,postgres}.test.ts`, `multi-horizon-scorecard-core.test.ts`,
    `research-{execution-microstructure,portfolio-allocator,sleeve4-sip-reference}.test.ts`,
    `verify-intraday-alpha-replay.test.ts`.
- **After #16395:** retain. The PR adds v3 in this directory and keeps v1/v2 evidence support. Additional direct
  importers in the proposed patch include `src/composition/native-execution-runtime.ts`,
  `src/execution/risk-policy.ts`, `src/intraday-replay/{decision-builder,decision-latency}.ts`, `src/jev/portfolio.ts`,
  `src/observe-composition/{position-protection-interpreter,recovery-driver}.ts`, and the tests
  `src/db/effective-entry-observe-cutover.integration.test.ts` and `src/strategy/macro-canary-etf/policy.test.ts`.
  The [ORB/ZAB freeze](evidence/2026-11-27-orb-zab-research/freeze.json) also binds alpha source bytes for historical
  reproduction. Do not prune old phase logic based solely on v3 entry admission.

#### `macro-etf-core/`

- **Code callers:** `tools/macro-etf-core-runner/{allocation,contract,market,planner}.ts`;
  `tools/{multi-horizon-scorecard-core,multi-horizon-scorecard-receipts}.ts`;
  `tools/research/{macro-etf-core-dual-horizon,macro-etf-core-dual-horizon-account,macro-etf-core-dual-horizon-data,macro-etf-core-wave5d}.ts`.
- **Tests:** local `golden-replay.test.ts`, `planner.test.ts`, `policy.test.ts`, `signals.test.ts`, and their
  `fixtures.test-support.ts`; `tools/{multi-horizon-scorecard-core,run-macro-etf-core-rebalance}.test.ts` and
  `tools/research/macro-etf-core-dual-horizon.test.ts`.
- **After #16395:** retain. The separate F2/F4 runner and [dual-horizon replay](evidence/2026-11-27-macro-etf-core-dual-horizon/README.md)
  call this module; the intraday cutover does not replace overnight policy, compiler or planner.

#### `macro-canary-etf/`

- **External code callers:** none. Internally, `signals.ts` imports `policy.ts`; `rebalance-planner.ts` imports both.
  `tools/run-macro-canary-etf-rebalance.ts` and `tools/multi-horizon-scorecard-{core,receipts}.ts` instead call
  modules under `tools/macro-canary-runner/`; those are not dead with this directory.
- **Tests:** local `policy.test.ts`, `signals.test.ts`, `rebalance-planner.test.ts`, and `fixtures.test-support.ts`
  assert independent policy identity and golden reference parity. #16395 changes the first to check historical v2
  independently of active selection.
- **After #16395:** retain. The [rollout contract](macro-canary-etf-rollout.md) still calls out the pure module and
  its tested allocation as a separate integration candidate. Only retire the source and its local fixtures alongside
  an explicit decision to retire that candidate, updating the runbook; do not remove the operator runner with it.

#### `execution-model/` (shared, not a strategy)

- **Code callers:** `src/execution/mandate.ts`, `src/risk.ts`, `src/shadow-decision-contract.ts`, `src/target-planner/facts.ts`;
  `src/intraday-replay/{broker-checkpoint,broker-fees,broker,capital-ablation,control-portfolio,control-study,equity-edge-screen,execution-core,ledger,matched-entry-study,residual-shock,signal-study}.ts`;
  `src/jev/{entry-economics,entry-invalidation,entry-proposals,entry-sizing,exit,liquidation-economics,runtime,short-entry,trading-signals}.ts`;
  `src/observe-composition/{intraday-market-data,position-protection-interpreter}.ts`;
  `src/strategy/{etf-noise-area/exit-plan,intraday-alpha/exit-plan,intraday-alpha/policy-v2-1,macro-canary-etf/rebalance-planner,repeated-momentum/exit-plan}.ts`;
  `src/system-assessment/{equity-fee-cash,forward-evidence,frozen-control-report,valuation-quotes}.ts`;
  `tools/{benchmark-fee-validation,execution-microstructure-model,intraday-alpha-session-postgres,jev-abstention-report,jev-fee-sensitivity,live-profitability-audit-postgres,research-execution-microstructure,sip-bayn21-replay,verify-intraday-alpha-replay}.ts`.
- **Tests and fixtures:** local `adaptive-collars.test.ts`, `dated-fees.test.ts`;
  `src/execution-model.test.ts`, `src/execution/mandate.test.ts`, `src/intraday-replay/{crypto-economics,equity-edge-screen}.test.ts`,
  `src/jev/{entry-economics,liquidation-economics,signal-price-precision}.test.ts`;
  `src/strategy/intraday-alpha/{intraday-alpha.test.ts,test-support.ts}`, `src/testing/streaming-market-fixture.ts`,
  `tools/jev-fee-sensitivity.test.ts`.
- **After #16395:** retain. Fixed-point amounts, fees, margin and protection math serve both current execution and
  reproducibility.

# Offline six-bar ridge core

The ridge core fits and scores synthetic or caller-supplied research rows. It has no command, market-data reader,
portfolio adapter, or live strategy registration. Every artifact and score remains `UNQUALIFIED`, with controller
coverage `UNKNOWN`. A fitted coefficient is not evidence of profitability or permission to trade.

## Fit contract

`fitSixBarRidge` in `services/bayn/src/intraday-replay/six-bar-ridge-fit.ts` accepts a manifest, rows, and an
independently pinned manifest hash. The manifest binds the seven-feature definition, recipe, source revision,
source and calendar identities, label definition, fixed allocation budget, complete sessions, and required training rows.
The v2 manifest uses `requiredTrainingRowHashes` over each complete `{ features, label }` row, including the resolved
P&L, status, completion time, and label evidence hash. These pins bind resolved material before fitting; they do not
claim the labels were available when a prospective experiment was registered.
A hash binds supplied content. It cannot prove source authenticity or that a manifest was frozen before outcomes.

Sessions form chronological, disjoint training, validation, and holdout partitions. Every required training row must
appear exactly once. Features must be available by the decision. Labels must complete strictly before the fitting cutoff
and first evaluation decision. Each training row must match the manifest's source and calendar hashes, even when its
row hash has been recomputed. Validation and holdout values never enter the fitting interface.

For D nonempty training sessions and n rows in a session, each row weighs 1/(D\*n). Zero-opportunity sessions stay in
the manifest and artifact but contribute no fabricated training rows. Their eventual portfolio evaluation is outside
this module.

The target is 10,000 times net execution P&L divided by the fixed allocation budget. Both amounts use exact,
safe-integer micro-units. A $50 net gain on a partially filled $20,000 allocation is 25 basis points, regardless of
the filled notional. `NO_ENTRY_FILL` requires zero P&L. Missing, unresolved, or incomplete labels reject the fit.

The recipe uses training-weighted means and population scales, an unpenalized intercept, and lambda one on the
normalized weighted mean squared error. Exactly constant columns have zero scale and coefficient. Distinct values
that collapse numerically fail instead. Nonfinite arithmetic, overflow, and multiplication or normalization underflow
fail without clipping or a fallback solver.

Only the fitting module imports the exact `ml-matrix@6.15.0` dependency. It solves the seven-dimensional regularized
covariance system with Cholesky decomposition and checks the residual. The standardized covariance has trace at most
seven in exact arithmetic, so adding the identity bounds its eigenvalues between one and eight. Collinear columns
remain solvable. Weighted centering of both the standardized columns and target preserves the unpenalized intercept.

## Artifact and scoring contract

`decodeSixBarRidgeArtifact` and `scoreSixBarRidge` live in `six-bar-ridge.ts`. They use strict Effect schemas and the
existing canonical SHA-256 implementation. Callers provide expected artifact and manifest hashes plus the source
revision. The v2 artifact includes the genuine day-weighted `trainingTargetMeanBps`, which can differ from the
coordinate-adjusted intercept. Weaker unpublished v1 manifests and artifacts are rejected; there is no compatibility
path. The numerical recipe remains v1 and unchanged. Unknown fields and versions, reordered features, incompatible recipes, malformed dimensions, invalid
training counts, and inconsistent zero scales reject the artifact. Zero scale encodes constant status without a
second flag that could disagree.

The artifact retains the declared evaluation sessions, including dates, open/close bounds, first decisions, and
validation or holdout partitions. The scorer's third argument contains `artifact` (the expected identities above) and
`evaluation` (independently pinned source and calendar hashes, session date, partition, decision time, and the unique
complete `requiredFeatureRowHashes` set). Each pin hashes the full feature row, including its values and evidence ID.
Candidate count and hash membership must match that set exactly, so omitted, extra, duplicated, or altered rows fail.
An empty candidate set requires an explicitly empty expected set. The evaluation
calendar must match the artifact. Its capture source can differ from the training source, allowing a later holdout capture.
Callers must obtain expected content pins independently of the rows being checked, such as from their trusted
extractor output or a separately pinned manifest. Rehashing an unverified row is not an independent pin. Equality
binds supplied content; it does not prove original-receipt access or source authenticity.

The scorer applies the frozen training means, scales, intercept, and coefficients. Each candidate must match that
evaluation source, calendar, date, and decision, carry the matching feature definition, and have a unique symbol.
Features must be available during the selected session by the decision. The decision must be on or after the session's
first decision and strictly before its close. The declared session, partition, calendar, and decision are checked even
for an empty candidate set. SPY remains benchmark-only.
A score strictly greater than zero beats cash. Exact ties use ascending symbol order. An empty or nonpositive set
selects cash. Scores are predicted fixed-budget execution returns, not realized portfolio returns.

Reproducibility requires the same input, source, dependency, and runtime. The fitter sorts rows by session, decision,
symbol, and evidence identity before any arithmetic or data hashing. It does not claim cross-runtime bitwise equality.

## Verification

The colocated tests cover four independent closed-form numeric designs, chronological and manifest failures,
partial fills and no fills, constant and collinear features, artifact corruption, extreme numeric values, and cash
selection. The unequal-day oracle has mean 1.5, variance 2.75, target mean 6.5, and raw-unit slope 23/22.
An eight-row orthogonal design with original slopes 2, 4, ..., 14 yields ridge coefficients 1, 2, ..., 7.
Seeded property tests cover row permutation and within-day replication.

The solver has four transitive packages, all MIT licensed, with no native or GPU dependency. The scorer does not
import the fitting module. Existing production entry points do not import either module. The core does not implement
statistical registration, real-data fitting, costs, serial portfolio evaluation, or economic qualification.

## Offline paired portfolio

`bayn.control-study-input.v6` opts into `SIX_BAR_RIDGE_V1` versus `SIX_BAR_TRAINING_MEAN_V1` through the
existing `tools/control-study.ts` command. It requires mechanical management and a v2 artifact. The baseline
assigns the training-only weighted target mean to every admissible candidate. It does not use the full model
intercept. Strictly positive scores beat cash; exact ties choose ascending symbol order.

Both policies retain the native 30-minute warmup and two-second delay, with session-open anchored polls. Six
completed bars determine the feature window, not earlier entry eligibility. They use independent portfolios with
identical initial capital and rules. Different entries can change subsequent cash, risk and opportunity
availability. This is a policy-level comparison, not exposure-matched alpha.

The v6 input has `backtest`, `decisionLatencyMs`, `turnoverPolicy`, `management: MECHANICAL`, and `ridge`. Its
`ridge` object contains `artifact`, `expectedArtifact` with independently pinned `artifactHash`, `manifestHash`
and `sourceRevision`, the full raw research `calendar`, `expectedCalendarHash`, `evaluationSourceManifestHash`,
and `partition: VALIDATION | HOLDOUT`. It has no equity-relative repeated target weight. The command retains its
existing independently pinned input and source-receipt byte hashes.

Admission verifies the artifact and its full normalized calendar. The calendar contains declared training and
evaluation sessions. The execution calendar must be the exact contiguous subset through the immediate successor
of its final executed session. The successor supplies calendar context and is not executed. Selected dates,
partitions, open/close bounds and first eligible polls must match the artifact. Six-bar queries carry the full
calendar and verify its actual evidence hash; the execution-subset hash cannot stand in for it. The evaluation
source must be original capture and match the independently admitted manifest hash. Training and evaluation
sources can differ.

The model's label-definition hash must equal `ridgeExecutionLabelDefinition` for the actual execution settings.
It binds fixed principal budget, latency, cadence, execution model, IOC/liquidity and fee assumptions, cash and
whole-share rules, protective exits, turnover policy and economic risk bounds including gross/symbol weight limits.
An arbitrary caller-supplied artifact is not assumed to match those mechanics.

The fixed allocation budget is an adverse-limit principal cap. Current cash including fees, native risk and
turnover limits can reduce or block quantity; partial or absent fills never change the model-label denominator.
Session reports expose `sizing.mode: FIXED_PRINCIPAL_BUDGET` and the budget. Fills, partial exits, quote
liquidity, fees, marks and cash carry use the existing stateful control engine. Overlapping hypothetical labels
are never summed into portfolio returns.

Each candidate uses the existing causal six-bar extractor. Full-row content hashes are retained immediately after
verified extraction, before rows are projected for scoring. Both policies require exact membership and cardinality
against those original pins. The constant validates those contents without depending on Ridge normalization
arithmetic. Candidate-local missing, stale or over-late evidence and evidenced spread or size exclusions remain
explicit, retain their original observation and receipt hashes, and receive no allocation while other candidates
may proceed. Required benchmark gaps or spread/size exclusions make the whole decision unavailable, even when
every candidate also has missing evidence and even for a zero or negative training-mean baseline. Malformed,
premature, mixed-contract, ordering and watermark failures remain global. An unavailable decision makes the
session incomplete and leaves the minute window unconsumed so a later
causal poll can retry. Cash and canceled-entry sessions retain scheduled opportunities and allocated data
charges. Mechanical mode has no provider client or Jev journal. The legacy snapshot preflight explicitly rejects
v6 because its native snapshot contract does not establish six-bar input coverage.

Reports remain `UNQUALIFIED` with controller coverage `UNKNOWN`. The simulated poll denominator does not prove
production controller coverage. Original byte/receipt identity does not prove capture completeness or source
authenticity. Quote units, capacity, market impact, full latency and operating costs remain uncalibrated.
Known-cost replay P&L is not fully costed economic P&L. Existing operating-cost composition retains null
qualification when costs are unknown. No training run, holdout inspection, strategy activation or trading
authority is added by this adapter.

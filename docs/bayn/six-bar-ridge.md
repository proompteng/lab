# Offline six-bar ridge core

The ridge core fits and scores synthetic or caller-supplied research rows. It has no command, market-data reader,
portfolio adapter, or live strategy registration. Every artifact and score remains `UNQUALIFIED`, with controller
coverage `UNKNOWN`. A fitted coefficient is not evidence of profitability or permission to trade.

## Fit contract

`fitSixBarRidge` in `services/bayn/src/intraday-replay/six-bar-ridge-fit.ts` accepts a manifest, rows, and an
independently pinned manifest hash. The manifest binds the seven-feature definition, recipe, source revision,
source and calendar identities, label definition, fixed allocation budget, complete sessions, and required feature rows.
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
revision. Unknown fields and versions, reordered features, incompatible recipes, malformed dimensions, invalid
training counts, and inconsistent zero scales reject the artifact. Zero scale encodes constant status without a
second flag that could disagree.

The artifact retains the declared evaluation sessions, including dates, open/close bounds, first decisions, and
validation or holdout partitions. The scorer's third argument contains `artifact` (the expected identities above) and
`evaluation` (independently pinned source and calendar hashes, session date, partition, and decision time). The evaluation
calendar must match the artifact. Its capture source can differ from the training source, allowing a later holdout capture.
Callers must obtain these expected identities independently of the candidate rows; equality does not prove authenticity.

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
import the fitting module. Existing production entry points do not import either module. No statistical registration,
real-data fitting, costs, serial portfolio evaluation, or economic qualification is implemented here.

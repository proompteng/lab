# New paper-derived strategy research

Research cut: November 7, 2026, America/Los_Angeles.
Status: duration-flow development test completed with no added execution value over its constant-hazard control.
No demonstrated edge, prospective registration, or capital authorization.

## Decision

CosmosAlpha's graph-guided factor reference remains the first selected reproduction. Its original data and
self-hosted model now pass preflight, and the first Graph run is executing. Complete it before designing its Bayn adaptation. The first comparison is
Graph versus the authors' Chain search under the same data, proposals, evaluator, and experiment budget.
The existing six-bar ridge, momentum, breakout, and crash/VWAP implementations are controls or infrastructure.
They are not this campaign's new candidate. Reusing ridge as the candidate was considered and rejected before fitting.

This campaign must produce a new source-backed mechanism, its reproducible implementation, and a separate
prospective economic evaluation under the existing account and risk policy. Published predictive scores and
historical portfolio results do not establish Bayn profitability.

## Completed native-data experiment

The separate [duration-aware flow development test](duration-flow-development-2026-11-07.md) adapts the September
[Regimes in the Order Flow](https://arxiv.org/html/2609.07989v1) paper. It does not substitute for the three references
below or claim to reproduce their methods. The full run-length filter and original likelihood-selected settings
were evaluated using 13.84 million historical trades/quotes. Funded counterfactuals using native pricing found exactly
the same economic fills for the log-normal-duration candidate and constant-hazard control in both execution
scenarios and signing variants: added execution value was $0. The primary base case made $10.40 before unknown
operating/research costs, its stress entry did not fill, and tick-only sensitivity lost money. Do not promote this
mapping from these results.

The independent accounting/provenance audit passed across 16 matched portfolios, 84 modeled fills and 48 orders.
This is inspected historical development with zero prospective observations. The runtime versus sealed-request
risk-policy conformance check failed; it remains failed. The original economic screen's incorrect 100 bp entry
hurdle and the first funded run's reused order IDs are retained as failed/inconclusive records, alongside the
corrected runs. See the linked report for the exact method, assumptions, costs, validation and limitations.

## Three new hypotheses

### H1: graph-guided search discovers complementary factors

[CosmosAlpha](https://arxiv.org/html/2611.04555v1) organizes factor lineage, expression similarity, and exposure
correlation as distinct graph relations. It propagates quality, productive potential, and diversity before selecting
parents on Pareto fronts. The hypothesis is that this search finds complementary predictive factors more effectively
than Chain search at the same budget. The authors provide
[source at commit 237f0a56895fd295542e202be8f62be48d6e9995](https://github.com/wzhmtldswz/CosmosAlpha/tree/237f0a56895fd295542e202be8f62be48d6e9995).
Their daily China-equity experiment is a reference reproduction, not a native intraday strategy. The published
configuration also needs point-in-time membership, tradability, turnover, free-float turnover, industry, and size
exposures. Native OHLCV alone cannot supply those inputs. Do not reduce the 100-stock cross-sectional requirement
to fit Bayn's smaller universe or manufacture missing exposures.

### H2: pool-conditioned diffusion discovers a better joint signal

[AlphaPADI](https://arxiv.org/html/2610.04959v2), submitted October 4 and revised October 8, generates complete
factor pools through hierarchical discrete diffusion. The hypothesis is that conditioning structural revisions on
other pool members adds complementary information beyond independent formula generation. The reference uses a
static pool combiner and a multi-cohort daily portfolio. Its reproduction must retain the complete diffusion,
reconstruction, and preference objectives. A genetic search with the same name is not an implementation of this
method. The inspected manuscript mentions anonymized code, but its accessible HTML did not expose that repository.
Code availability is unresolved. Neither its predictive scores nor its portfolio construction transfers directly to
Bayn's one-position intraday policy.

### H3: persistent trader identities add information beyond anonymous flow

[Beyond Anonymous Order Flow](https://arxiv.org/html/2611.05218v1), submitted November 3, measures the incremental
predictive content of previously scored Hyperliquid wallets. The hypothesis is that persistent trader-specific
markouts identify informative flow beyond aggregate imbalance. Its retrospective specification choices, consensus
timestamps, and carried states through gaps limit the evidence. A reproduction needs wallet-attributed messages,
validity masks, anonymous controls, and original receipt-time measurements. A price-only model cannot reproduce
this mechanism. Any experiment using those signals with Bayn's existing broker must test cross-venue availability,
decay, execution delay, and fees directly. No new venue, derivative permission, or crypto activation is authorized.

## Frozen first experiment design

Design ID: `bayn.paper-edge.cosmosalpha-reference.v1`.
This freezes the reference-reproduction procedure. It is not a system qualification registration, and it does not
freeze a future fitted strategy or claim that an untouched prospective window has started.

The authoritative reference is the pinned source above, specifically
[`configs/graph_experiment.toml`](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/configs/graph_experiment.toml),
[`docs/graph.md`](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/docs/graph.md),
and the linked implementation modules. Preserve the published method and document any source/manuscript discrepancy
before running the affected comparison.

1. Pin raw source bytes, configuration, dependencies, source data, masks, calendar, adjustments, and source receipts.
   Verify the complete input contract. Missing data or unavailable model access leaves the run unexecuted.
2. Reproduce Graph Flow, relation normalization, isolated-node behavior, Pareto fronts, crowding, fertility, and
   attempt accounting against the pinned implementation and independent numerical checks. Mechanical parity is a
   prerequisite, not an economic result.
3. Run the full Graph and Chain references on the same admitted panel. Preserve their actual configurations,
   prompts, responses, failures, repair calls, elapsed time, and metering. Compare attempts and successful evaluations
   separately. Match budgets without dropping failed proposals. Report all runs rather than the best seed.
4. Preserve the reference's train/validation/test separation and downstream evaluator. Published test dates are
   historical reproduction evidence for this campaign. They are never relabeled as untouched prospective evidence.
5. Assess the resulting factors' mechanism, redundancy, turnover, timing, and sensitivity. A higher RankIC does not
   select a deployable strategy by itself. A null result remains a completed reference experiment.
6. Define a separate Bayn adaptation only after the reference is understood. Freeze its new factor language,
   complete research panel, causal target, search budget, model identity, selected strategy, matched control, costs,
   and exact execution rules before its final evaluation. A changed horizon is a changed experiment.

The reference configuration sets two initial factors, at most four parents per round, 100 expansion attempts,
five attempts per node, and up to two child proposals per attempt. Graph Flow uses gamma 0.75, at most 100 numerical
iterations, and tolerance 1e-8. Initialization and repair calls have their own accounting. These are algorithm
budgets, not economic qualification quotas. Paper and configuration settings must be reconciled before reporting
full reproduction.

The pinned Chain example has one workflow cycle, while Graph has 100 expansion attempts. These defaults are not
a matched comparison. Register the exact shared accounting and arm configurations before outcomes; do not compare
the unmodified examples and attribute the difference to graph search. Cold-start initialization, failed attempts,
unique evaluated factors, and actual provider calls remain distinct counts.

## Prospective economic boundary

Use the existing [system qualification policy](../../services/bayn/src/system-assessment/policy.ts) and
[economic evaluator](../../services/bayn/src/system-assessment/economic-qualification.ts). Current qualification
requires `bayn.system-registration.v4` and the registered conditional statistical plan. Bootstrap diagnostics do
not replace this gate. Supports and the conditional mean model are explicit assumptions; daily loss limits and
observed extrema do not prove them. Check statistical feasibility before consuming an evaluation window.

The candidate, cash, and simple matched control need independently evolving portfolios over the same registered
calendar. Carry cash, positions, fees, and risk history. Retain no-trade periods, failures, partial fills, and missed
deadlines. Attribute inference, data, infrastructure, and research costs without double counting. Missing costs stay
unknown. Positive absolute and paired lower bounds, complete evidence, and the existing risk constraints are required
before claiming an edge. Research or image delivery cannot grant capital authority.

The [original data boundary](market-data-archive.md) and [native comparison](control-portfolios.md) remain binding.
Historical REST retrieval cannot establish original trading-worker receipt times. The retained September 10–11
comparison is inspected development evidence with modeled availability and unresolved operating costs. It is not
training admission for an original-capture-only command or a new prospective window.

## Reference input access

The pinned author README links the original [Zenodo data bundle](https://zenodo.org/records/23857833).
Use that route before reconstructing or purchasing the reference data. The [input-source assessment](cosmosalpha-input-sources-2026-11-07.md)
records the exact archive identity, dependency preparation, model-version distinction and current API pricing.
Qlib and LightGBM now import in the supported Python environment; all 13 retained upstream tests and eight
independent graph checks pass. The original bundle is checksum-verified, extracted and loaded by the native provider:
2,286 dates, 629 historical instruments and 685,511 samples. Independent artifact checks pass, with at least 200 eligible
instruments per evaluation date. Industry history remains uncertified for strict point-in-time use. Eligible rows contain
279 null industry IDs, 158 null `free_turn` values and three null `returns` values. The existing self-hosted Flamingo endpoint
now supplies model access without a paid API key. All six amended configurations pass native preflight. The matched
Graph/Chain experiment is running; its comparison and economic qualification remain unfinished.
The earlier missing default local paths did not establish that the authors had not published the dataset.

The [matched reference budget and accounting assessment](cosmosalpha-reference-budget-2026-11-07.md) now specifies
three paired runs, a shared maximum proposal allowance, declared Qwen sampling settings and complete
physical-request accounting. Native contract probes exposed missing-usage counters represented as zero and up to
ten physical requests for one logical call. The active runner uses Flamingo and strips the upstream client's non-secret
anonymous-auth compatibility marker. The earlier DeepSeek spending proposal is withdrawn. No external model charge
is required; local compute and research costs remain unallocated.

## Execution order and outstanding evidence

Proceed in this order: source and data admission, deterministic method parity, reference comparison, separately
frozen Bayn adaptation, prospective source collection, and complete economic assessment. Keep a decision trail and
all rejected trials. Do not build a new generic strategy platform to perform these experiments.

The source commit and reference design are selected. Original input loading and self-hosted model access are verified.
Reference results, the Bayn adaptation, operating-cost allocation, and prospective registration remain unproven.
The duration-flow adaptation was fitted and tested separately as documented above; it is not qualified. The three
selected reference mechanisms have no completed comparison yet. CosmosAlpha is executing; the other two remain unexecuted. The full profitability goal remains unachieved.

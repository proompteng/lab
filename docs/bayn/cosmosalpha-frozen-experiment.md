# Frozen CosmosAlpha calendar-target experiment

The runner binds verified calendar targets to native Graph, multi-tree MCTS and gamma-zero Graph mining, then fits the same chronological LightGBM experiment to every complete pool. It uses the existing self-hosted Flamingo model. The resulting study is a declared calendar-target and Qwen backbone variant of CosmosAlpha.

## Prepare and freeze

If the previous task-local environment or TOMLs are unavailable, follow [input reconstruction](cosmosalpha-reconstruction.md) to create and declare a separate acceptance from the pinned author files and checksum-verified original data.

Use the native Python 3.12 research environment with CosmosAlpha author commit `237f0a56895fd295542e202be8f62be48d6e9995` and its pinned dependencies. Apply these repairs to that source before installing it:

1. [Numeric literals and Graph duplicate decisions](evidence/2026-11-07-cosmosalpha-source-repair/source.patch).
2. [MCTS prompts, request construction and self-hosted output limits](evidence/2026-11-08-cosmosalpha-mcts-repair/source.patch).
3. [MCTS completed-round accounting](evidence/2026-11-09-cosmosalpha-mcts-rounds/source.patch).
4. [MCTS failed-root admission](evidence/2026-11-09-cosmosalpha-mcts-root-admission/source.patch).
5. [MCTS candidate evidence binding](evidence/2026-11-09-cosmosalpha-candidate-binding/source.patch).

The patches use paths relative to the author repository and apply in order with `patch -p1`. The second repair sends the prompt text that the original helpers discarded, normalizes boundary whitespace that the native message validator rejects, removes an unsupported request argument and aligns suggestions with the client's JSON-object response contract. It also declares output limits of 2,000 tokens for suggestions and 20,000 for portraits. The third repair charges completed MCTS rounds instead of the loop index at termination: a tree that exhausts its budget after one round previously reported two, consuming the global allowance early. The fourth requires a validated expression and measured RankIC before a root can enter search. Failed root generation consumes one global round and starts another root; an actually measured RankIC of zero remains valid. These repairs retain the search-score and evaluator formulas.

The fifth repair resolves a single candidate for both root and expansion nodes. Previously, a two-design result could select the second accepted expression while reading the first design's metrics and factor values. The selected factor, proposal, validation, evaluation, preprocessing, snapshot and artifact references must now agree and occur unambiguously in the candidate and experiment indexes. Raw turnover and evaluated diversity values come from that same candidate. Missing or ambiguous evidence is rejected; the selector preserves candidate order and does not maximize a different candidate's metric. The [native regression](evidence/2026-11-09-cosmosalpha-candidate-binding/validation.json) covers both node paths, measured-zero scores and missing or contradictory evidence.

The runner accepts one registered source inventory, `651a11dfc78f75893051ae809e27979365e2bda11b1a294eb7027deb9d8524a9`. It hashes all 101 installed source assets itself. Four author files contain the declared repairs; 97 remain unchanged. A caller-supplied claim about an upstream commit cannot admit another source variant. The [round-accounting regression](evidence/2026-11-09-cosmosalpha-mcts-rounds/validation.json) exercises the native tree loop, backpropagation, persistence and transitions between trees with synthetic expansion results and no inference. The [failed-root regression](evidence/2026-11-09-cosmosalpha-mcts-root-admission/validation.json) exercises the native default root generator, failed-round accounting, root regeneration and search with a measured zero RankIC.

LightGBM's native runtime must load before freeze or execution can begin. On macOS its installed wheel needs OpenMP, available as Homebrew `libomp`. Admission records the platform and native LightGBM binary hash alongside Python package versions. The native contract check also exercises a small synthetic fit and prediction. This catches dependency failures before data preparation or model inference; it does not replace the full-data model checks.

These auxiliary limits adapt the declared Qwen backbone. The original 300-token suggestion calls exhausted their output on reasoning without JSON. Portrait probes also returned no content at 2,000 and 4,000 tokens; a probe under the existing 20,000-token ceiling returned a usable portrait using 10,796 completion tokens. Calibration used response validity, not held-out performance. Actual tokens remain charged against the common per-arm ceiling.

Create a request using the existing training-only native Graph and chronological LightGBM TOML configurations, the [calendar-target request](cosmosalpha-calendar-targets.md) and its generated target directory:

```json
{
  "schemaVersion": "bayn.cosmosalpha-experiment-request.v1",
  "kind": "study",
  "baseConfig": "/research/native-graph.toml",
  "downstreamConfig": "/research/native-lightgbm.toml",
  "targetRequest": "/research/calendar-target-request.json",
  "targetDirectory": "/research/calendar-targets"
}
```

Paths resolve relative to the request file. Use a fresh output directory for every freeze:

```sh
python packages/scripts/src/bayn/cosmosalpha_experiment.py freeze \
  /research/experiment-request.json /research/calendar-study
```

Freeze performs native config admission and the existing configuration audit. It independently recomputes all target rows, then loads the native mining and full downstream snapshots from the original Qlib providers. It checks every consumed close, mask and key against the independent source oracle. Both target projections must have zero unexplained mismatches.

The frozen plan includes the snapshots, projected native return artifacts, target identity, source inventory, Python dependencies, all configurations, runner implementation and live model identity. It also hashes the original Qlib provider files, including quote fields read later by the native portfolio backtest. Checks before and after each mining arm and model fit reject provider drift. Frozen snapshots alone would not cover those later quote reads.

## Comparison and budgets

The study contains all nine runs in this order:

| Seed     | Arm order            |
| -------- | -------------------- |
| 20260823 | Graph, MCTS, no-Flow |
| 20260824 | MCTS, no-Flow, Graph |
| 20260825 | no-Flow, Graph, MCTS |

MCTS stops at the next expansion boundary after the shared target is met. Its final cycle feedback can complete, and the native helper fallback cannot turn the stop into more model calls.

The same guard applies before a new MCTS root. The author's internal node counter also includes unavailable RankIC values; it is not used as a second output limit. The shared coverage-qualified evaluation counter owns the factor target.

Each run targets exactly 150 unique, technically evaluable factors. Both accepted and threshold-rejected factors count when they satisfy the native coverage gate. Failed evaluations and duplicates do not count. Concurrent evaluations reserve capacity before computation so they cannot overshoot the target.

Every arm has the same hard ceilings:

| Resource                                            |    Per arm |
| --------------------------------------------------- | ---------: |
| Requested proposal slots                            |        600 |
| Physical inference HTTP requests, including retries |      2,000 |
| Actual completion tokens                            | 20,000,000 |
| Maximum output tokens on any request                |     20,000 |

The 600-slot ceiling leaves room for MCTS cycles that emit one factor while requesting up to two. This is a common ceiling, not a claim that every requested slot becomes a parsed or evaluable factor. Failed cycles keep their charged slots. The runner retains proposal, evaluation and physical-request events separately.

Graph has a native safety bound of 300 expansion attempts. MCTS has a bound of 300 total multi-tree rounds. These native units differ and are not the comparison budget. MCTS uses `MCTSController.run_multi_tree` with free roots and the shared factor zoo. Python, NumPy and model requests use the registered seed. Graph and no-Flow retain paired settings except gamma and output storage; no-Flow sets gamma to zero.

All arms use `qwen38-flamingo` through `http://flamingo.ide-newton.ts.net/v1`. The fixed profile uses temperature 0, top-p 0.95, top-k 20, min-p 0, presence and frequency penalties 0, repetition penalty 1 and thinking enabled. Stage limits remain bounded by the common output ceiling, including the declared MCTS auxiliary adaptations. The runner sends no authorization header, follows no redirects and has no model fallback.

The exact served model, checkpoint, tokenizer, chat template and image must match the frozen identity on every response. The runner saves raw requests and responses plus their hashes. Unknown usage blocks further requests in that arm. Output-token reservations prevent concurrent calls from exceeding the completion-token ceiling.

## Run and verify

```sh
python packages/scripts/src/bayn/cosmosalpha_experiment.py run \
  /research/calendar-study/plan.json

python packages/scripts/src/bayn/cosmosalpha_experiment.py audit \
  /research/calendar-study/plan.json
```

The output directory has one execution owner. An existing receipt directory prevents replay. There is no resume, top-up, replacement seed or best-seed selection. Failed arms remain in the result, and the runner attempts the remaining planned mining arms. Pre-run identity failures record an unstarted arm without sending inference. Post-run identity-check exceptions preserve the original arm failure and its usage receipt. A shortfall makes the study inconclusive.

The client records whether each native MCTS suggestion or portrait response contains usable JSON. A native helper cannot silently fall back from a failed auxiliary response and still qualify the arm. MCTS requires at least one successful auxiliary response; any failed auxiliary response blocks further model calls and makes it inconclusive even if it reaches the factor target.

No held-out fitting starts until every planned mining pool is complete. Search uses April 1, 2010 through May 31, 2019. The downstream split uses that same training interval, June 1, 2019 through December 31, 2020 for validation, and January 1, 2021 through December 31, 2025 for testing. Targets cannot cross split cutoffs. Both the mining evaluator and downstream model receive the verified native return artifacts instead of the legacy return calculator.

The native LightGBM path consumes every factor in each matched pool, including threshold-rejected factors. Source admission accepts Graph and MCTS directly and rejects search on validation or test dates. It preserves the native feature calculations, preprocessing, fit and offline portfolio configuration.

The final audit independently reads the saved wire bodies, reconciles actual token usage and request counts with receipts, validates auxiliary JSON against the actual returned content, verifies pool identity and checks native evaluation target references. It also checks the selected factor count, downstream target binding and hashes of model, prediction, signal and portfolio artifacts. Only a complete matrix with a passing audit receives a paired descriptive comparison across all registered seeds.

## Acceptance and tests

Set `kind` to `acceptance` for a separate functional experiment with all three arms and seed 20260823. Each arm targets four evaluable factors, with ceilings of 16 requested slots, 80 physical requests and 800,000 completion tokens. Its identity and results remain separate from the nine-arm study. Acceptance cannot establish the paper's performance advantage.

The [completed functional acceptance](evidence/2026-11-08-cosmosalpha-calendar-experiment/acceptance.json) reached four qualified factors in each arm, made 42 physical model calls with zero unknown usage and completed all three native LightGBM fits. The audit verified all 18 downstream output artifacts and full-pool target consumption with zero verification failures. Its independent full-data target check found zero unexplained mismatches across 1,165,440 rows. This four-factor result does not establish that the 150-factor scientific study will complete or demonstrate an advantage.

That acceptance used a prior source inventory. A later acceptance of the completed-round repair was stopped when a failed root-generation experiment with no evaluations became the native `chain-root` placeholder. The subsequent portrait and design requests refined that placeholder using default scores. The [root-admission evidence](evidence/2026-11-09-cosmosalpha-mcts-root-admission/validation.json) retains the failed experiment and request hashes. Its final in-flight request has unsettled usage; no held-out models or scientific arms ran. The stopped trial cannot qualify this control.

The [reconstructed Linux diagnostic](evidence/2026-11-09-cosmosalpha-root-acceptance/acceptance.json) on the root-admission source completed three four-factor arms, 39 requests, 130,694 completion tokens and three downstream models, with zero unknown usage and a passing frozen audit. Independent checks verified all 18 model outputs and 1,076,118 prediction targets; the maximum aggregate-metric error was `5.56e-17`. Its four MCTS records each contain one candidate and pass the repaired selector's identity checks. During that diagnostic, the separate native two-design regression reproduced the candidate-binding defect. The diagnostic retains its original `d881` inventory and is not acceptance of the new repair.

The candidate-binding source passed its [separate functional acceptance](evidence/2026-11-09-cosmosalpha-candidate-binding/acceptance.json). Its [pre-outcome freeze](evidence/2026-11-09-cosmosalpha-candidate-binding/acceptance-freeze.json) binds the imported controller, source inventory, targets, runtime, model identity and unchanged capped allowances. All three four-factor pools and downstream fits completed in 2,145 seconds, using 39 physical requests and 138,638 completion tokens with zero unknown usage. The frozen audit passed; independent verification checked all 18 output artifacts and 1,076,118 prediction targets with maximum aggregate-metric error `2.78e-17`. All nine downstream definition and corruption checks passed.

The [retained MCTS audit](evidence/2026-11-09-cosmosalpha-candidate-binding/audit_native_binding.py) checked four single-candidate records, their cycle/pool expressions and scores, and 12 raw/evaluated/target artifact references. No live result contained two designs. The quota stop left zero native tree snapshots, and native node factor arrays are memory-only; the report marks saved-tree verification unavailable. The exact-source regression supplies the two-design binding proof. These limits do not disappear when the functional checks pass. No nine-arm scientific study has run, and the acceptance does not qualify profitability. Earlier frozen plans, runner snapshots and failed or diagnostic evidence retain their original identities.

Portable boundary tests run without the native research dependencies:

```sh
python3 packages/scripts/src/bayn/test_cosmosalpha_experiment.py
bun test packages/scripts/src/bayn/cosmosalpha-experiment.test.ts
```

With the native environment and a prepared plan, exercise the real factories, evaluator, target consumer and multi-tree orchestration:

```sh
python packages/scripts/src/bayn/check_cosmosalpha_experiment_native.py \
  /research/calendar-study/plan.json
python -m pytest -q \
  docs/bayn/evidence/2026-11-07-cosmosalpha-source-repair/test_source_repair.py \
  docs/bayn/evidence/2026-11-08-cosmosalpha-mcts-repair/test_mcts_prompts.py \
  docs/bayn/evidence/2026-11-09-cosmosalpha-candidate-binding/test_candidate_binding.py
```

The three native prompt regression cases failed before their respective repairs, including the case that uses the real portrait prompt builder. Earlier acceptance trials retain their empty-conversation HTTP 400 and reasoning-truncation evidence. Neither reached held-out fitting. They are not replayed or relabeled as repaired trials.

## Independently verify downstream metrics

After all planned models finish, use the reference Python environment with NumPy and SciPy:

```sh
python packages/scripts/src/bayn/verify_cosmosalpha_downstream.py \
  /research/calendar-study /research/downstream-metrics.json
python packages/scripts/src/bayn/check_cosmosalpha_downstream.py \
  /research/calendar-study
```

The verifier checks all six output artifact hashes per model and joins every prediction target to the verified raw target artifact. It recomputes daily IC and RankIC, sample counts and all seven aggregate metrics. Correlations retain their signs, daily dispersion uses sample standard deviation, and portfolio analysis uses 238 trading days and signed arithmetic drawdown. A missing model or mismatch fails verification. Existing report files are rejected.

The [repaired-source acceptance check](evidence/2026-11-09-cosmosalpha-downstream-metrics/validation.json) covers three four-factor fits and all 21 reported metrics. Its maximum aggregate-metric error is below `3e-17`. Definition cases and corrupted saved-model inputs exercise the verifier's failure paths. Portfolio calculations start from the saved zero-cost daily report; they do not independently replay fills or qualify costed strategy edge.

## Paper-to-runtime evidence

The reference is [CosmosAlpha v1](https://arxiv.org/html/2611.04555v1), particularly Sections 3.2–3.4 and Appendices B–D. Evidence boundaries remain separate:

The quality archive supplies marginal hypervolume credit. Parent selection uses a different Pareto ordering over propagated quality, fertility and diversity. Setting gamma to zero preserves those utilities and selection while removing propagation.

The [independent propagation check](evidence/2026-11-08-cosmosalpha-calendar-experiment/verify_flow_artifacts.py) reconstructs relation normalization from saved snapshots, replays the recurrence with NumPy and solves the fixed-point linear system separately. Across all 14 Graph/no-Flow states in the completed acceptance, replay differs from native output by at most 2.23e-16; the direct solution differs by at most 3.03e-9, within the configured convergence bound. [Results](evidence/2026-11-08-cosmosalpha-calendar-experiment/flow-recomputation.json) bind every input artifact and the verifier by hash. Injected reward, iteration-count and negative-relation corruptions were each rejected. This check is conditional on recorded raw utilities and relation weights; it does not independently reconstruct quality, fertility or Pareto selection.

| Boundary                      | Owning code and observed evidence                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed relations and utilities | Pinned `graph/core.py`, `structure.py`, `reward.py` and `flow.py` retain the author's generation, structure and correlation graph; intrinsic quality, birth-time hypervolume credit, attempt fertility and reference distance. Source and upstream numerical cases were checked. This is not an independent recomputation of every archive update.           |
| Flow and selection            | `flow.iterative_flow` implements the fixed-point recurrence; `selector` retains Pareto fronts and crowding. The [actual selector artifacts](evidence/2026-11-08-cosmosalpha-calendar-experiment/flow-artifact-check.json) show convergence in 14 states: all seven no-Flow states retain raw utilities, and all seven Graph states change them.              |
| MCTS                          | `MCTSController.run_multi_tree` generates roots within the run and shares its factor zoo. The pinned runtime installs `MCTSHypothesisStub` and `MCTSFeedbackStub`; these construct domain objects without model calls. Design, expression, repair and portrait agents still call the model. Native tests exercise free roots and both quota-stop boundaries. |
| Shared factors and data       | The frozen configs retain windows 5/10/20, depth 15, two repair attempts, chronological segments, daily coverage gates, neutralization and shared LightGBM settings. Target consumption has its own independent full-data oracle. Industry history and historical feature-calendar semantics remain unqualified.                                             |
| Integration                   | [Three canonical downstream diagnostics](evidence/2026-11-08-cosmosalpha-calendar-experiment/downstream-diagnostic.json) used all four factors per retained pool, verified 18 output artifacts and matched the full target binding. These diagnostics do not convert the earlier failed acceptance into a pass.                                              |

The [MCTS route evidence](evidence/2026-11-09-cosmosalpha-mcts-runtime-route.json) binds the runtime and stub agents to unchanged author source hashes and checks actual requests. This corrects the earlier claim that the model-based hypothesis stage remains active. The [paper's Appendix D](https://arxiv.org/html/2611.04555v1) lists hypothesis calls for MCTS root generation and expansion; the pinned runtime uses the stub. Its additional portrait guidance is also absent from that route table. All actual calls and their usage remain charged.

This experiment deliberately changes the backbone to self-hosted Qwen, uses corrected calendar targets and imposes explicit request/token ceilings. Its 20,000-token common output ceiling and declared auxiliary limits differ from the paper's 12,000-token setting. The study covers CSI 300 and three methods, not the paper's complete cross-universe baseline suite. The MCTS source route adds another difference. These differences prevent a claim of exact reproduction of published results. The Graph/MCTS comparison measures these complete source pipelines; the Graph/no-Flow pair keeps the same prompt routes and differs only in gamma and output storage.

The paired report retains the four predictive and three portfolio metrics specified by the paper. Native Qlib portfolio analysis uses arithmetic-return risk analysis with a zero benchmark; the runner does not reinterpret its signed drawdown as compounded wealth drawdown.

## Interpretation limits

Industry metadata has not passed point-in-time admission. Historical feature and rolling-window semantics remain those of the pinned native source except for the corrected targets. The native portfolio diagnostic retains its reference 100-million book and zero transaction costs. Neither those returns nor configuration agreement establish executable, costed strategy edge. The runner grants no broker or live-capital authority and leaves earlier exploratory trials unchanged.

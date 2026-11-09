# Frozen CosmosAlpha calendar-target experiment

The runner binds verified calendar targets to native Graph, multi-tree MCTS and gamma-zero Graph mining, then fits the same chronological LightGBM experiment to every complete pool. It uses the existing self-hosted Flamingo model. The resulting study is a declared calendar-target and Qwen backbone variant of CosmosAlpha.

## Prepare and freeze

Use the native Python 3.12 research environment with CosmosAlpha author commit `237f0a56895fd295542e202be8f62be48d6e9995` and its pinned dependencies. Apply these repairs to that source before installing it:

1. [Numeric literals and Graph duplicate decisions](evidence/2026-11-07-cosmosalpha-source-repair/source.patch).
2. [MCTS prompt messages and request construction](evidence/2026-11-08-cosmosalpha-mcts-repair/source.patch).

The patches use paths relative to the author repository and apply with `patch -p1`. The second repair retains the suggestion and portrait output limits of 300 and 800 tokens. It sends the prompt text that the original helpers discarded, removes an unsupported request argument and aligns suggestions with the client's JSON-object response contract. It changes no search-score or evaluator math.

The runner accepts one registered source inventory, `48bfb6fe9501929271e8a22b3e67f82209a39183d6326fc65a9e451b2588de49`. It hashes all 101 installed source assets itself. Four author files contain the declared repairs; 97 remain unchanged. A caller-supplied claim about an upstream commit cannot admit another source variant.

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

Each run targets exactly 150 unique, technically evaluable factors. Both accepted and threshold-rejected factors count when they satisfy the native coverage gate. Failed evaluations and duplicates do not count. Concurrent evaluations reserve capacity before computation so they cannot overshoot the target.

Every arm has the same hard ceilings:

| Resource                                  |    Per arm |
| ----------------------------------------- | ---------: |
| Requested proposal slots                  |        600 |
| Physical HTTP requests, including retries |      2,000 |
| Actual completion tokens                  | 20,000,000 |
| Maximum output tokens on any request      |     20,000 |

The 600-slot ceiling leaves room for MCTS cycles that emit one factor while requesting up to two. This is a common ceiling, not a claim that every requested slot becomes a parsed or evaluable factor. Failed cycles keep their charged slots. The runner retains proposal, evaluation and physical-request events separately.

Graph has a native safety bound of 300 expansion attempts. MCTS has a bound of 300 total multi-tree rounds. These native units differ and are not the comparison budget. MCTS uses `MCTSController.run_multi_tree` with free roots and the shared factor zoo. Python, NumPy and model requests use the registered seed. Graph and no-Flow retain paired settings except gamma and output storage; no-Flow sets gamma to zero.

All arms use `qwen38-flamingo` through `http://flamingo.ide-newton.ts.net/v1`. The fixed profile uses temperature 0, top-p 0.95, top-k 20, min-p 0, presence and frequency penalties 0, repetition penalty 1 and thinking enabled. Native stage limits remain intact beneath the common output ceiling. The runner sends no authorization header, follows no redirects and has no model fallback.

The exact served model, checkpoint, tokenizer, chat template and image must match the frozen identity on every response. The runner saves raw requests and responses plus their hashes. Unknown usage blocks further requests in that arm. Output-token reservations prevent concurrent calls from exceeding the completion-token ceiling.

## Run and verify

```sh
python packages/scripts/src/bayn/cosmosalpha_experiment.py run \
  /research/calendar-study/plan.json

python packages/scripts/src/bayn/cosmosalpha_experiment.py audit \
  /research/calendar-study/plan.json
```

The output directory has one execution owner. An existing receipt directory prevents replay. There is no resume, top-up, replacement seed or best-seed selection. Failed arms remain in the result, and the runner attempts the remaining planned mining arms. A shortfall makes the study inconclusive.

No held-out fitting starts until every planned mining pool is complete. Search uses April 1, 2010 through May 31, 2019. The downstream split uses that same training interval, June 1, 2019 through December 31, 2020 for validation, and January 1, 2021 through December 31, 2025 for testing. Targets cannot cross split cutoffs. Both the mining evaluator and downstream model receive the verified native return artifacts instead of the legacy return calculator.

The native LightGBM path consumes every factor in each matched pool, including threshold-rejected factors. Source admission accepts Graph and MCTS directly and rejects search on validation or test dates. It preserves the native feature calculations, preprocessing, fit and offline portfolio configuration.

The final audit independently reads the saved wire bodies, reconciles actual token usage and request counts with receipts, verifies pool identity and checks native evaluation target references. It also checks the selected factor count, downstream target binding and hashes of model, prediction, signal and portfolio artifacts. Only a complete matrix with a passing audit receives a paired descriptive comparison across all registered seeds.

## Acceptance and tests

Set `kind` to `acceptance` for a separate functional experiment with all three arms and seed 20260823. Each arm targets four evaluable factors, with ceilings of 16 requested slots, 80 physical requests and 800,000 completion tokens. Its identity and results remain separate from the nine-arm study. Acceptance cannot establish the paper's performance advantage.

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
  docs/bayn/evidence/2026-11-08-cosmosalpha-mcts-repair/test_mcts_prompts.py
```

The new MCTS regression cases failed before the prompt repair. The earlier failed acceptance trial retains its empty-conversation HTTP 400 evidence and did not start held-out fitting. It is not replayed or relabeled as the repaired trial.

## Interpretation limits

Industry metadata has not passed point-in-time admission. Historical feature and rolling-window semantics remain those of the pinned native source except for the corrected targets. The native portfolio diagnostic retains its reference 100-million book and zero transaction costs. Neither those returns nor configuration agreement establish executable, costed strategy edge. The runner grants no broker or live-capital authority and leaves earlier exploratory trials unchanged.

# CosmosAlpha reference comparison with self-hosted inference

Research cut: November 7, 2026, America/Los_Angeles. The selected Graph/Chain comparison uses existing Flamingo capacity. All six native preflights pass, and the first Graph run is executing. The earlier DeepSeek-specific $60 spending proposal is withdrawn.

## Experimental contrast

The comparison retains the pinned [Graph controller](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/pipeline/graph/controller.py) and serial Chain architecture. It uses the same original panel, evaluator, admission thresholds, backbone, sampling profile and maximum proposal allowance. Initialization, prompts, feedback and concurrency remain architectural differences. This compares complete search systems and cannot isolate graph propagation alone.

The active task-local plan is `bayn.cosmosalpha-selfhosted-reference.v1`. Three paired replicates use seeds 20260823, 20260824 and 20260825. Arm order alternates between pairs. Failed arms and seeds are retained rather than replaced.

| Setting | Graph | Chain |
|---|---|---|
| Search | 100 expansion attempts | 102 serial cycles |
| Initialization | Two cold roots, at most four fresh initialization cycles | Native serial initialization and history |
| Proposal slots | One per initialization cycle, two per expansion attempt | Two per cycle |
| Maximum total proposal slots | 204, including initialization | 204 |
| Runtime workers | Four | One |
| Global output-token ceiling | 20,000 | 20,000 |
| External model API fees | $0 | $0 |

A failed cycle consumes its configured proposal-slot allowance even if hypothesis generation, parsing, duplication or evaluation fails. Repair calls and HTTP retries remain counted. Unused allowance is reported rather than transferred or topped up. Requested, parsed, unique, evaluated and accepted factors remain separate counts. No terminal-failure resume extends the fresh initialization allowance.

The [runtime factories](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/pipeline/runtime.py) apply the one-proposal override only to Graph initialization. Expansion keeps the configured two-proposal maximum. Graph uses deterministic feedback; Chain uses its LLM feedback stage. The shipped Chain example has one cycle, so this comparison explicitly sets 102. Graph's duplicate coordinator waits for every parent in a batch. Its four workers are retained to cover the maximum batch.

## Backbone and request settings

[Flamingo](../../argocd/applications/flamingo/README.md) serves `qwen38-flamingo` at `http://flamingo.ide-newton.ts.net/v1`. Live readback confirmed:

- Model repository `nvidia/Qwen3.8-27B-NVFP4`.
- Checkpoint and tokenizer revision `482ca0f3832238542f8f5295dde86b5f22711d80`.
- Serving image digest `sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2`.
- Context limit 262,144 tokens and eight maximum active server sequences.

Anonymous model-list and JSON completion calls succeeded. The latter consumed 23 prompt and six completion tokens. The actual native first hypothesis call then returned structured content with 1,518 completion tokens. No paid-provider access was necessary.

Both arms request temperature 0, top-p 0.95, top-k 20, min-p 0, repetition penalty 1, no presence or frequency penalty, the per-run seed, and Qwen thinking enabled. No DeepSeek reasoning-effort equivalence is asserted. The client timeout is 1,800 seconds to allow non-streaming generation on shared local capacity. These are declared backbone/runtime changes from the published DeepSeek configuration, not evidence of reproducing its model-specific results.

The global 20,000-token ceiling does not override every [prompt-manifest cap](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/llm/templates/v2/manifest.yaml). Effective stages remain bounded by the native agent/template logic: ordinary stages use 12,000, while Graph design can use 20,000. The previous description of 20,000 at every stage was incorrect. Actual submitted limits are recorded for each request.

The upstream config requires a nonempty key field even for anonymous endpoints. The adapter identifies its value as a non-secret compatibility marker and strips Authorization before sending. It neither provisions credentials nor changes the service. Dedicated optional environment-variable names prevent the former paid-provider environment settings from selecting another route. The transport accepts only the frozen Flamingo endpoint and model.

## Data and accounting

All configurations preserve the original [verified inputs](cosmosalpha-input-sources-2026-11-07.md), calendar, masks, adjustments, 100-stock minimum and 80% admission thresholds. Industry point-in-time certification remains absent and sparse fields remain null. Neither missing values nor cross-section requirements are weakened to fit the experiment.

An independent return-label audit matched all 685,511 panel prices to the original Qlib binaries and reproduced the native filtered-panel labels. Among 634,291 eligible comparable rows, 94 labels differ from the same suspension-compression rule applied to the complete calendar. The native calculation skips index-membership gaps. For example, `sh600176` on July 29, 2010 uses a close 1,924 trading days later and records a 205.4% return; the next full-calendar close gives about 0.2095%. This is a verified limitation of the retained reference. The running inputs are unchanged. Calendar-correct sensitivity and a separate causal target are required before native adaptation or an economic interpretation.

Every physical HTTP attempt is journaled with submitted payload hash, model, seed, token cap, timestamps, response hash, status and observed usage. Raw prompts and responses also remain in the native run artifacts. Missing usage stays unknown rather than being interpreted as the native client's zero counters. Returned model identity is checked, and live serving identity is compared before and after each arm. The run has no paid-provider fallback.

External model API fees are zero. Reserved GPU capacity, local CPU/storage and research costs remain unallocated. Cumulative HTTP time includes waiting and overlapping requests; it is not GPU active time or a provider invoice. No fully costed economic conclusion follows from these inference receipts.

## Interpretation and remaining boundary

Report all three paired quality archives, hypervolume, factor redundancy and turnover with complete resource counts. A shared maximum allowance does not guarantee identical realized calls, factor counts or elapsed time. Incomplete arms and unknown costs remain inconclusive. Successful subsets cannot establish the comparison.

The pinned [LightGBM example](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/configs/lightgbm_integration.example.toml) trains through May 2019, validates through 2020 and tests during 2021–2025. Preserve those chronological segments after search results are frozen. Its `account = 100000000` and zero opening, closing, minimum and impact costs are reference diagnostics. They do not describe Bayn capital or a fully costed portfolio. The entire downstream input window loaded and passed artifact alignment checks, without fitting models or inspecting strategy performance.

The reference comparison has started and remains incomplete. A causal Bayn adaptation, cost allocation, prospective registration and positive absolute and paired profit lower bounds are still required. This experiment grants no capital authority.

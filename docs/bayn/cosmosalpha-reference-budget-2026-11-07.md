# CosmosAlpha reference comparison and cost accounting

Research cut: November 7, 2026, America/Los_Angeles. Status: frozen preparation, unexecuted. Provider spending and API access are not authorized. No model calls were made.

## Experimental contrast

The comparison retains the pinned [Graph implementation](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/pipeline/graph/controller.py) and serial Chain architecture. It uses the same original data, evaluator, admission thresholds, model settings, maximum proposal allowance and provider-fee allowance. It compares the complete search systems. Initialization, prompts and concurrency remain architectural differences, so the result cannot isolate graph propagation alone.

The task-local plan is `bayn.cosmosalpha-matched-reference-plan.v3`. Earlier unexecuted plans remain retained. Three paired replicates use runtime seeds 20260823, 20260824 and 20260825. Arm order alternates between pairs. No failed arm or seed is replaced.

| Setting | Graph | Chain |
|---|---|---|
| Search | 100 expansion attempts | 102 serial cycles |
| Initialization | Two cold roots, at most four fresh initialization cycles | Native serial initialization and history |
| Proposal slots | One per initialization cycle, two per expansion attempt | Two per cycle |
| Maximum total proposal slots | 204, including initialization | 204 |
| Runtime workers | Four | One |
| Per-call output cap | 20,000 tokens | 20,000 tokens |
| Reasoning effort | Explicit `max` | Explicit `max` |
| Proposed provider-fee ceiling | $10 per arm | $10 per arm |

Six arms have a proposed total provider ceiling of $60. This covers model requests only. It excludes research, local compute and other operating costs, which remain separate economic-accounting requirements. The ceiling is a stopping rule, not a prediction that all six arms will finish within it.

A failed cycle consumes its configured proposal-slot allowance even if hypothesis generation, parsing, duplication or evaluation fails. Repair calls and HTTP retries consume provider budget and remain visible. Unused allowance is reported rather than transferred or topped up. Actual proposals, successful evaluations and accepted factors remain distinct counts. No terminal-failure resume extends the fresh initialization allowance.

The source [runtime factories](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/pipeline/runtime.py) apply the one-proposal override only to Graph initialization. Expansion keeps the configured two-proposal maximum. The shipped Chain example has one cycle, so it requires the explicit 102-cycle override for this comparison. Graph's duplicate coordinator waits for every parent in a batch. Reducing its worker count below the possible batch size can stall that barrier; the reference keeps four workers.

## Declared changes from the examples

All six configurations preserve the original reference panel, calendar, masks, adjustments, 100-stock minimum and 80% admission thresholds. The [verified original inputs](cosmosalpha-input-sources-2026-11-07.md) still carry industry point-in-time and missing-value limitations.

Both arms explicitly request `reasoning_effort = "max"`. The shipped examples omit it, while the paper reports maximum effort. The [current API documentation](https://api-docs.deepseek.com/guides/thinking_mode/) defaults to `high` and ignores temperature in thinking mode. Sending temperature zero and fixing runtime seeds therefore does not establish deterministic provider output.

The source [prompt manifest](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/llm/templates/v2/manifest.yaml) gives Graph design a 20,000-token cap while other stages default to 12,000. The matched configurations set 20,000 for both arms at every stage. This is a declared replication arm, not byte-identical execution of the example TOMLs. The current documented DeepSeek backend also differs from the paper's named version. Raw returned model IDs and contemporaneous version documentation must be retained; a returned alias does not identify immutable weights.

## Cost accounting verified offline

An actual pinned-client contract probe showed that a response without `usage` becomes zero input and output tokens. Those counters do not establish zero cost. Another probe exercised nine retries and a tenth successful physical request for one logical call. The [native client](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/src/cosmosalpha/llm/openai_compatible.py) retains raw responses, so raw usage and invoice reconciliation remain authoritative for costs.

The experiment-only transport gate durably reserves $1 before each physical request. Valid raw usage replaces that reservation with a conservative peak, uncached token-fee bound using the [published rates](https://api-docs.deepseek.com/quick_start/pricing/). Reasoning tokens are a subset of completion tokens and are not added twice. Cache credits are not assumed in that bound. Unknown charges retain the full reservation and stop further requests. An unresolved request after a process exit also prevents retransmission. This controls requests under verified tariff and context bounds; it does not replace a provider invoice.

Eight local durability, concurrency and accounting checks pass. Five further cases pass through the pinned native client and retry executor. Known-usage truncation and malformed content remain counted across retries. Missing usage, ambiguous timeouts and server errors without usage stop at one physical request. Header credentials are not persisted, and a credential echoed by a provider fixture is redacted before persistence.

These are non-network contract and fault-injection checks. They provide no model-quality or search-performance evidence. All six native configuration preflights fail only on `LLM_API_KEY_NOT_CONFIGURED`. The runner defaults to preflight and requires a recorded spending approval plus a fresh pricing receipt before execution. Real-endpoint compatibility remains unverified.

## Interpretation and remaining boundary

Report all three paired quality archives, hypervolume, factor redundancy and turnover together with complete resource counts. A shared maximum allowance does not imply identical realized calls, factor counts or elapsed time. Incomplete arms and unresolved charges remain inconclusive. A successful subset cannot establish the comparison.

The pinned [LightGBM example](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/configs/lightgbm_integration.example.toml) trains through May 2019, validates through 2020 and tests during 2021–2025. Preserve those chronological segments after search results are frozen. Its `account = 100000000` and zero opening, closing, minimum and impact costs are reference diagnostics. They do not describe Bayn's capital or a fully costed portfolio.

The reference comparison remains unexecuted. A separate causal Bayn adaptation, operating-cost allocation, prospective registration and positive absolute and paired profit lower bounds are still required. This plan grants no capital authority.

# Using Jev and TypeSafe in Bayn

Research date: October 18, 2026. This is a research record, not trading authority or a profitable-strategy qualification.
This audit records `bayn.jev.protocol.v10` and `bayn.jev-trading-signal-state.v9`. The subsequent focused-action change removes unused diagnostics and distinguishes the forecast horizon from the lookback; see the current [service contract](../../services/bayn/README.md). Check the deployed source,
immutable image, retained requests and actual broker/accounting receipts before applying any operational conclusion.

## What Jev does

Jev is TypeSafe's System One decision model. It consumes application state and typed questions, returning bounded
judgments and probabilities. It does not generate a textual answer autoregressively. The publisher describes a new
architecture, a parallel sampler and Reinforcement Learning for Calibrated Decisions, or RLCD. Its launch FAQ
explicitly distinguishes Jev from an LLM. I found no public first-party technical paper disclosing its parameter
count, layers, training-data recipe or RLCD reward equations. Those details remain undisclosed.
[Publisher's description and FAQ](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[System One](https://docs.typesafe.ai/concepts/system-one),
[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer).

Natural-language instructions remain part of the interface. Their presence does not make Jev a chat model. There
is no conversation to continue or reasoning transcript to parse. State must explicitly supply the relevant facts.
The surrounding application retrieves information, computes exact values, keeps state and performs side effects.
[Building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[State](https://docs.typesafe.ai/concepts/state).

The publisher's type-safety claim concerns the output interface. A correctly typed answer can still be factually
wrong, ambiguous or useless for a particular market. Published automation results do not establish trading alpha.
TypeSafe's workflow evaluation uses reference judgments from other models and assumes the workflow is correct.
It does not measure realized financial outcomes. [Evaluation methodology](https://evals.typesafe.ai/),
[Published evaluation code](https://github.com/typesafe-ai/WorkflowEvals/tree/0ac3b8ad845429f0d8e064ecfb2430a47c5a25cb).

## The request and answer contract

The native endpoint is `POST https://api.typesafe.ai/v1/systemone`. The main inputs are `model`, `state` and
`questions`. Question IDs connect responses to application code; the model does not see them. Put the complete
meaning in instructions and criteria. Choice option names and descriptions are visible to the model.
[HTTP API](https://docs.typesafe.ai/api).

| Needed answer               | Question type | Interpretation                                                                                   |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| One item from a defined set | Choice        | The returned distribution compares the supplied options. Include an appropriate no-match option. |
| Whether a condition holds   | Noul          | A probability of yes. A value near 0.5 expresses uncertainty, not moderate intensity.            |
| Degree on an ordered rubric | Score         | A probability-weighted rubric position. Levels must describe concrete situations independently.  |

Score accepts 2–10 levels and Choice up to 255 options. Score is not a calculator for interpolating an exact price,
return or size. Use code for arithmetic, counting and time comparisons.
[Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul),
[Score](https://docs.typesafe.ai/primitives/score), [Known 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

All questions in one request see the same state and run independently in parallel. They cannot read one another's
answers. Independent evaluation does not imply statistically independent answers. Multiplying their probabilities
does not create a justified joint probability. Batch independent judgments; use a second call when the first answer
is needed to retrieve evidence or construct the next state or answer options.
[Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions),
[Speculative questions](https://docs.typesafe.ai/patterns/fan-out).

For Choice with `n` options, confidence is `(p_max - 1/n) / (1 - 1/n)`. With three options, a top probability of
0.40 gives confidence 0.10. This is distribution concentration, not a second independent estimate of correctness
or the probability of a profitable trade. Score confidence also accounts for distances between rubric levels.
Keep the full distributions. Evaluate any threshold against the exact event, domain and consequences it governs.
[Confidence](https://docs.typesafe.ai/confidence).

## Official agent guidance

The official skill is installed at `.agents/skills/typesafe-ai/SKILL.md`. It is pinned to publisher commit
`65a39f393687675ce170e6094757de20370365b9`, with one documented link correction: the missing migration guide is
replaced by the official SDK changelogs. The personal Codex copy and repository copy match; the MIT license is
unchanged. [Official installation instructions](https://docs.typesafe.ai/agent-skill),
[Pinned upstream skill](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md),
[Upstream missing-link issue](https://github.com/typesafe-ai/skills/issues/14).

The skill supports bounded contextual action choices. It does not require a question to be literal fact extraction,
every diagnostic to control a branch, or every probability to become a veto. Decompose judgments where the parts
are useful, preserve relationships that need joint interpretation, and let code own calculations and execution.

## What Bayn currently asks

Definitions are in [trading-signals.ts](../../services/bayn/src/jev/trading-signals.ts).
The five entry instructions are:

| ID and type            | Actual question                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `regime`, Choice       | Which current price-action regime best fits the candidate, considering its recent path, computed signals and benchmark context?                                                                                                           |
| `continuation`, Noul   | Does the combined candidate price path, volume, technical signals and benchmark context support sustained upward continuation over the stated horizon?                                                                                    |
| `exhaustion`, Noul     | Does the candidate show a stretched or weakening upward move with meaningful reversal risk over the stated horizon? Evaluate the joint pattern rather than applying one indicator threshold.                                              |
| `setup_quality`, Score | How coherent is the candidate long-entry setup across price action, volume, technical signals and benchmark context? Missing indicators provide no supporting evidence. Do not calculate sizing or treat this score as a return forecast. |
| `action`, Choice       | Given the candidate and benchmark trading signals, which long-only entry decision is best supported for the stated horizon? This question assesses the setup; deterministic code separately checks permission, sizing and risk.           |

Regime options are `upward_trend`, `downward_trend`, `range`, `unstable`, `unclear`. Setup quality has five levels,
from no supported setup through strongly aligned evidence. Action options are `enter`, `wait`, `avoid`.

The current [entry decision](../../services/bayn/src/jev/decision.ts) consumes the chosen action, requires verified
funded economics and an eligible execution quote, ranks eligible candidates by `p(enter)`, and takes at most one
position. There is no current minimum entry-probability threshold. The other four answers are retained diagnostics;
they do not feed their answers into the parallel action question and do not impose additional entry vetoes.

Before inference, deterministic code requires positive own and benchmark-relative momentum from a common observed
minute. This is the current short-window momentum screen. Calling it the published long-horizon TSMOM strategy
would overstate what is implemented. Candidate evidence failures, capital occupancy and expired observations can
prevent inference or an order independently of model selection.

Management reuses continuation and exhaustion and asks a separate `hold / exit / unclear` action. Its instruction
references actual held-position economics, actual entry fees and estimated exit fees. It explicitly says entry fees
are sunk costs and that an unmet break-even price cannot postpone an otherwise justified exit. A model-driven exit
requires the chosen exit and `p(exit) >= 0.65`; protective stops and the holding deadline operate independently.

The previous `net_economics` entry question and mandatory support veto were removed by PR15185, along with the
cost-focused action instruction. Fee estimates and break-even calculations remain in code and input context.
Removing one parallel question alone does not prove another answer changed; the earlier action wording and
deterministic veto also changed. A paired prompt diagnostic is not a profitable-strategy qualification.

## Verified integration issues and test targets

### Input meaning

The retained v9 requests reproduce through native request hashing and match the source question definitions. They
carry candidate and benchmark bars, precomputed technical and relative signals, missingness, quotes/trades and
code-computed entry economics. Raw bar history is not automatically invalid input. Compare it with a compact state
containing the relevant computed features and explicit units before deciding which is better.

The prediction horizon is 15 minutes, while some relative-return fields describe the observed lookback. Generic
wording such as "stated horizon" should be tested against an explicit reference to the intended state field.
Canonical request serialization also orders the action criteria `avoid, enter, wait`. Choice order sensitivity is
a documented 1.13 limitation. Test permutations as a stability diagnostic; do not select whichever permutation
happens to produce the best historical P&L. Neither issue has been established as the cause of a particular loss.

### SDK and transport contract

The official JavaScript SDK 0.7.0 allows nullable token counts. Bayn currently requires nonnegative integers.
The HTTP documentation still presents integer counts. That is a documented contract discrepancy to resolve with
explicit unknown metering, not by manufacturing zero usage. The retained response failures inspected in this
investigation all had numeric usage, so null usage was not their cause.
[SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog),
[Pinned SDK usage type](https://github.com/typesafe-ai/typesafe-sdk-js/blob/b844cd1aca12855a5d24a2df52a1401c86e7d37a/src/types.ts#L198).

The inspected contradictory responses include a selected `wait` with probability 0.37 while `avoid` has 0.38.
The HTTP contract defines the choice as the highest-probability option. Do not silently replace the provider's
choice or widen numerical tolerances to obtain an entry. Preserve the failed response and its cost. Two older
floating-point tie cases already pass the current machine-precision allowance.

The SDK defaults to two retries, a 10-second timeout per attempt and no total retry budget. It also follows bounded
server retry delays. Dropping those defaults into a trading observation would allow work beyond Bayn's validity
window. Keep the absolute observation deadline and cancellation across every attempted call. Existing Effect scope
ownership and the approved CONNECT proxy must be retained. Do not replace the native client merely to match an SDK
example. [Pinned retry defaults](https://github.com/typesafe-ai/typesafe-sdk-js/blob/b844cd1aca12855a5d24a2df52a1401c86e7d37a/src/retry.ts),
[Timeout semantics](https://github.com/typesafe-ai/typesafe-sdk-js/blob/b844cd1aca12855a5d24a2df52a1401c86e7d37a/src/types.ts#L276).

### Reporting and data failures are separate from model quality

An actual native report exposed a wide-payload SQL sort timeout. After that repair deployed, the same report exposed
a second limit: one aggregate PostgreSQL message was 19,397,450 bytes, above the driver's 16,777,216-byte maximum.
The responsible fix returns individual evidence records in one SQL statement. It preserves the shared snapshot,
complete payloads, request limit, unknown-cost handling and canonical ordering. Increasing a timeout or the wire
limit does not remove that unnecessary aggregate. This is a reporting defect, not evidence that Jev is slow.

SOL's missing-trade exclusion was independently compared with Alpaca's latest-trade endpoint and Dorvud's archive.
Their latest actual SOL trade timestamps agreed while bars and quotes were current. This case occurs before Jev
and must not be relabeled as an inference outage or repaired with a fabricated trade.

## How to tune performance properly

### Freeze the target before optimizing questions

The current action question judges setup support. Its probabilities are not labeled probabilities of a positive
fee-net round trip. A code-computed break-even price is an accounting calculation, not an expected future price.
Define the executable entry, stop, native exit lifecycle and full costs, then measure outcomes for that definition.
Keep missing, unfilled, partial, expired, blocked and no-trade opportunities in the sample.

Use the existing [matched entry study](matched-entry-study.md). It compares immediate deterministic momentum,
the same candidate delayed to actual batch commitment, and Jev selection. Identical execution and mechanical exit
rules separate selection from latency. Independent native portfolios are required for portfolio P&L; overlapping
opportunity labels cannot simply be added together.

### Fit useful signals, not invented vetoes

Compare the action distribution with existing diagnostics and deterministic numerical features. If Jev contributes
information, fit a small downstream model against actual outcomes and compare it with a numerical-only baseline.
Retain raw judgments so a fitted weight change need not repeat inference over identical evidence. Correlated
questions are not independent evidence, and arbitrary products or weighted sums are not calibrated success odds.

The official feature-discovery cookbook uses Jev as a semantic feature encoder for a downstream CatBoost model.
An LLM proposes candidate questions offline in that example; Jev itself remains the typed decision model. Its
wine-review results are not financial validation, and its random-fold splits are unsuitable for overlapping trading
labels. [Feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery),
[Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

Use chronological blocks, prevent training on outcomes unavailable at each cutoff, remove overlapping-label leakage,
and leave a final time period untouched. Retain every attempted variant and failed screen. Measure ranking,
calibration to a defined event, and fee-net portfolio results separately. Proper scores cannot validate a vaguely
defined event, and a high win rate can still lose money. [Proper scoring rules](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf),
[Backtest overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

### Measure the whole execution interval

Separate provider HTTP time from queueing, observation construction, database claim/receipt persistence, target
commitment, refreshed quotes and broker response. An observed short model call does not bound the interval to a
broker fill. Use matched timing witnesses for the same opportunities, including tails and failures. Keep the
10-second quote/inference validity and all capital, stop, turnover and holding limits.

Pin a model version during comparison. The documentation read today points `jev-latest` at 1.13.0 and
`jev-preview` at 1.14.0. Default context limits are 64k tokens per request and 32k per question. State is ingested
once; all questions plus state must fit the request limit and each question plus state must fit the question limit.
Experimental long context raises both to 262k with documented accuracy and latency costs. It is unnecessary for
the current requests. There is no documented temperature, top-p or reasoning-effort knob, and TypeSafe does not
offer customer fine-tuning or LoRA. [Models and customization](https://docs.typesafe.ai/models).

The original five-session registered captures and arrival witnesses remain unrecovered. Synthetic fixtures and
new development exports cannot complete that experiment. This research does not qualify a replacement strategy
or prove profitable BTC/ETH/SOL PAPER trades. Any strategy promotion must still pass the existing release process
and be verified through actual fills, final fee handling, native accounting and exact reconciliation.

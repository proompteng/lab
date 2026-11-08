# Duration-aware flow: funded development result

The duration-aware candidate did not add execution value over its constant-hazard control. Both produced exactly the same economic fills in every tested scenario and signing variant. Do not promote this implementation on these results. This is a completed development experiment, not a general rejection of duration-aware filtering or an established profitable strategy.

The candidate is a native-data adaptation of [Regimes in the Order Flow](https://arxiv.org/html/2609.07989v1), submitted September 7, 2026. Its full Gaussian run-length posterior uses a discrete log-normal duration hazard. Those underlying changepoint methods predate this paper; the mechanism is new to Bayn. The paper's LOBSTER signed-trade experiment has not been reproduced exactly.

## Observed execution PnL

These are hypothetical, modeled execution cash flows after native dated fees and declared execution assumptions. Operating, research and financing/cash opportunity costs remain unknown, so these figures are not fully costed profit. The three inspected dates are November 3–5, 2026. Cash, inventory and cumulative fills carry through the entire period without daily cash resets.

| Signing | Scenario | Candidate completed trades | Candidate | Constant hazard | Rolling six buckets | Candidate − constant |
|---|---|---:|---:|---:|---:|---:|
| Quote + tick tie (primary) | base | 1 | $10.40 | $10.40 | $-6.57 | $0.00 |
| Quote + tick tie (primary) | stress | 0 | $0.00 | $0.00 | $-54.53 | $0.00 |
| Tick only (sensitivity) | base | 1 | $-137.58 | $-137.58 | $-299.13 | $0.00 |
| Tick only (sensitivity) | stress | 1 | $-52.32 | $-52.32 | $-234.12 | $0.00 |

Cash has zero modeled execution PnL; its operating/opportunity costs are not assumed to be zero. Every modeled portfolio ended flat. The candidate's primary base result comes from one NVDA round trip on November 3. Its primary stress entry did not fill. Tick-only results come from one AAPL round trip on November 5. All candidate exits that filled were triggered by the matched research stop. A transient adverse IEX bid can trigger a stop and then recover before the delayed sell executes; a stop trigger does not determine the realized loss.

The candidate outperformed the losing rolling control in these cases, but had exactly $0 paired improvement over the constant-hazard control, including identical prices, quantities, times and fees. There is no positive incremental lower bound for the proposed duration mechanism. These portfolios are matched comparisons, not 16 independent replications. Stronger tick-only flow-MSE results did not translate into positive execution PnL.

## What was frozen and executed

Native pricing and accounting use [source revision cef577a22e4fef1a31d6229260cb08da64c8f88f](https://github.com/proompteng/lab/tree/cef577a22e4fef1a31d6229260cb08da64c8f88f/services/bayn/src).

November 2 selected nine constant-hazard and nine log-normal settings by calibration predictive likelihood for each asset/signing variant. Original intercept/slope mappings from flow forecasts to 15-minute midpoint returns were retained without refitting. That is 72 calibration fits, not 72 independent economic trials. Later outcomes are development observations, and none has been relabeled as prospective evidence.

The first economic screen incorrectly imposed a retained momentum control's 100 bp target as a mean-return entry hurdle. Its zero heuristic entries did not reject profitability. The corrected native-price audit and funded test are separate retained experiments. Their designs were frozen before their respective outcomes; funded rules were frozen after forecast-margin counts and entry identities had already been inspected. The corrected tests do not turn the original screen into an uninspected test.

The native-price audit found one later primary positive forecast margin for each Gaussian arm and three in tick-only signing. Native source functions calculated whole-share sizing, acquisition cash, dated fees and conservative exit value, instead of the erroneous flat mean-return hurdle. A positive forecast margin is neither a fill nor profit.

The funded test used the same long-only, one-position, 20% allocation, source-defined notional caps and existing account identity for every arm. Starting cash was a virtual reference from a current read of the existing Bayn sandbox account, not a historical opening checkpoint or an actual broker ledger reset. Account balances, credentials and personal identifiers are omitted from this report.

- Base: one-second order latency, zero modeled market-data delay, all displayed IEX liquidity, no additional adverse execution, native fees.
- Stress: five-second order latency, one-second modeled market-data delay, one-quarter of displayed IEX liquidity, two basis points of adverse execution and doubled fees.
- Entry: original bucket end plus two seconds; strictly earlier visible quote, at most ten seconds old, at most 20 bp spread; positive native conservative forecast margin at terminal spread multiplier one. No substitution for missing fits.
- Orders: source-priced DAY limits. Entry uses the v40 zero-drift ceiling. Cancellation is requested after ten seconds and acknowledged after the scenario latency; fills before acknowledgement and partial fills are retained. Available displayed shares are consumed once per quote/side within each portfolio.
- Exit: matched research choices of a 50 bp protective stop, 100 bp conservative net target or 15-minute horizon, followed by decision and order delay. These stop/target choices are not universal account constraints. Source sell pricing allows ten basis points below the trigger bid. Unfilled exits retry; unresolved inventory would remain open and block later entries.

The driver calls Bayn's actual `jevEntryEconomics`, `jevLiquidationValue`, `deriveExecutionIntentPricing`, `assessEntryTurnoverReserve`, `simulateIntradayReplayExecution` and `applyReplayFill`. It does not fabricate streaming offsets or original worker arrivals to pass a higher-level qualification boundary. This is a counterfactual using native math primitives, not execution of the current Jev proposal workflow or evidence of actual broker fills.

## Evidence and limits

The source consists of 13,843,463 historical trades and quotes on 1,393 complete pages for AAPL/NVDA, November 2–5. Provider responses, cursor chains, query completion and content hashes remain retained privately. Same-nanosecond ambiguous quote states are excluded. Historical REST data does not establish the original feed's completeness, original worker receipt times, publication revisions, consolidated routability or queue position.

Historical quote sizes were interpreted as shares, following the [REST quote reference](https://docs.alpaca.markets/us/reference/stockquotesingle-1) and [November 2025 size-unit change](https://docs.alpaca.markets/us/v1.1/changelog/marketdata-bid-and-ask-size-display-change). The older streaming round-lot wording was not applied to these REST responses. The six later-session quote caches retain exact microdollar prices, day-relative nanoseconds, share sizes, ambiguity flags and source hashes.

The same Bayn account identity was verified through the existing read-only integration. A separately connected account was not substituted. The current source protocol hash matches the captured runtime protocol hash. The read-only process's execution-risk hash differs from both its sealed request and the approved sandbox policy derived from current source. The strict conformance exporter failed and remains failed. Source-approved notional limits were used for unqualified diagnostics only. No credential, permission, account, capital-authority or risk-policy changes were made.

Original historical loss, peak-equity, turnover and existing-position checkpoints are unavailable. The virtual incremental risk guards are not proof of account risk eligibility. Operating/research costs are unknown. Prospective observations: zero. Absolute positive profit lower bound: not established. Positive paired incremental lower bound: not established. New-strategy capital authority: none.

## Verification

An independent Python audit passed across 16 portfolios, 84 modeled fills and 48 orders. It independently reconstructed dated cumulative fees and exact cash, checked original quote bytes and flags, strictly prior quote timing, latency/cancellation, adverse-price rounding, order limits, whole shares, notional ceilings, per-quote liquidity consumption, overselling, nonnegative cash, session carry, trade reconciliation, causal entry quotes and protective-stop triggers. Candidate and constant-hazard economic fills matched exactly in every scenario/signing pair.

The first funded run failed that audit because unfilled attempts reused order IDs. Its output is retained as failed provenance. A monotonic entry-attempt sequence fixed the IDs; an amended rerun preserved identical economic fills and session results. Both the initial and extended independent audits of the corrected run passed. No failure was discarded or reclassified as a passed trial. Separate in-memory fault probes rejected a one-microdollar cash error, a pre-arrival fill, a breached order limit and overstated displayed liquidity. The probes exercised the financial and provenance assertions independently of the cross-version equality check.

The numerical filter oracle and full-source transport-overlap checks from the predictive experiment also passed. Pinned Bun 1.4.2 and Node 24.11.1 were available in the local Nix store despite an unavailable Nix daemon. The native-import dispatcher declaration fix passed all six Bayn service checks: 4,954 tests passed, 1,282 skipped, zero failed; type checks, both lint modes, type-aware lint and build passed. Its emitted JavaScript is identical before and after the type-only fix. Strategy integration and live deployment have not been performed.

## Retained artifacts and next decision

The campaign’s local evidence directory contains the original predictive specification, raw page receipts, numerical oracle, native account/policy evidence, failed runs, frozen funded design, both funded outputs, independent audit code/results, manifests and decision log. Raw market data and account source evidence remain private. The report is not a self-contained redistributable dataset.

Key artifacts are `duration-funded-design.v1.json`, `duration-funded-input-manifest.v1.json`, `duration-funded-amendment.v2.json`, `duration-funded-replay.v2.ts`, `duration-funded-v2.private.json` and `duration-funded-independent-check.v2-extended.json`. The v1 driver/output remain available to reproduce the failed provenance audit. The retained `duration-funded-evidence-manifest.v2-extended.json` records their exact content hashes. Raw data and account-source receipts are not part of the repository report.

Do not spend an untouched evaluation window on this fitted return mapping based on these results. Any changed predictor, target, signing rule or execution policy is a new development experiment and must retain these results. The separate CosmosAlpha Graph-versus-Chain reference remains unexecuted because its required provider data, point-in-time exposures, Qlib and original-model route did not pass preflight. AlphaPADI implementation availability is still unresolved after inspecting HTML and its manuscript TeX archive. Neither has been replaced with an old ridge candidate or relabeled as reproduced. The full profitability goal remains active.

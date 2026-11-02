# Additional feed research, 2026-10-13

Bayn has not established a durable profit after all costs. Paid feed adoption is deferred. Execution latency,
cost coverage and matched strategy comparisons take priority. This note records existing access and research
hypotheses. It activates no feed, changes no trading policy and authorizes no purchase.

## Existing access is enough to investigate coverage

Alpaca Basic provides real-time IEX data and historical SIP data when the request ends at least 15 minutes ago.
Those historical SIP requests can evaluate bar coverage without a new subscription. Historical retrieval does
not establish the original publication, transport or consumer arrival time.

Sources: [Alpaca market-data plans](https://docs.alpaca.markets/us/docs/about-market-data-api) and
[Alpaca feed and entitlement rules](https://docs.alpaca.markets/us/docs/market-data-faq).

A direct provider comparison used the existing Torghut credential after the October 13 regular session. The
request covered 13:30 through 20:00 UTC, with raw one-minute bars for all 16 source-controlled symbols. Both
feeds returned successfully. SIP supplied all 390 expected bars for every symbol. IEX had missing bars for
13 symbols. AAPL, AVGO and NVDA had complete IEX coverage.

| Symbol | Expected bars | IEX bars | SIP bars | Complete IEX 30-minute entry windows | Complete SIP windows |
| ------ | ------------: | -------: | -------: | -----------------------------------: | -------------------: |
| AAPL   |           390 |      390 |      390 |                                  355 |                  355 |
| NVDA   |           390 |      390 |      390 |                                  355 |                  355 |
| SPY    |           390 |      388 |      390 |                                  295 |                  355 |
| QQQ    |           390 |      379 |      390 |                                  177 |                  355 |
| AMZN   |           390 |      378 |      390 |                                  139 |                  355 |
| CRDO   |           390 |      340 |      390 |                                   70 |                  355 |

The entry-window count uses every minute boundary from 14:00 UTC through the last boundary before the
19:55 UTC entry cutoff. It tests bar presence alone. Quote freshness, feature publication, source revision,
model evidence and order feasibility remain separate requirements. These counts cannot estimate missed profit.

The private evidence is `full-session-historical-feed-comparison.json` in the
`bayn-execution-cost-20261013` operator artifact directory. It includes every symbol and missing timestamp.

Alpaca aggregates bars from qualifying trades. A minute without eligible price updates can have no bar even
when some trades occurred. A feed-coverage experiment must preserve that distinction rather than fill missing
minutes with invented prices. Source: [Alpaca bar aggregation rules](https://docs.alpaca.markets/us/docs/market-data-faq).

## Additional information worth testing

| Source                            | Access established                                                                                      | First bounded experiment                                                                                       | Evidence limit                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Existing Alpaca historical SIP    | Direct HTTP 200 for the complete session, without a new subscription                                    | Compare missing windows and quote-based cost scenarios against IEX on the same fixed dates                     | Final historical records do not establish live arrival or executable liquidity                                     |
| Existing Alpaca news              | Direct HTTP 200 using the Torghut credential; five sample articles returned                             | Freeze a company-news event filter and compare it with unchanged momentum on untouched sessions                | Read access alone does not establish the billing tariff or a useful trading signal                                 |
| SEC EDGAR submissions             | Official public JSON APIs require no API key; account-specific runtime adoption is unverified           | Test a predeclared 8-K event-risk filter                                                                       | Preserve filing acceptance time, retrieval time and amendments; annual facts alone do not explain a 15-minute move |
| BLS and Federal Reserve calendars | Official public release and FOMC calendars are available                                                | Compare an event blackout with the same strategy and costs                                                     | A scheduled event flag is a risk hypothesis, not observed alpha                                                    |
| FRED and ALFRED                   | Official APIs expose observations and vintage dates; a usable local API key is unverified               | Test slow regime context using only values available at the decision time                                      | Revised macroeconomic values cannot replace their original vintage in a historical test                            |
| Databento historical evaluation   | Official documentation offers new-account evaluation credits; no account or entitlement was provisioned | Consider a bounded independent microstructure dataset only after the existing evidence exposes a specific need | Evaluation credits are finite and live subscriptions or exchange licensing can cost money                          |

Alpaca's news schema includes article identity, source, related symbols, creation time and update time. Historical
news dates to 2015. The existing credential's successful read was verified at 22:51 UTC on October 13. No article
content, credentials or account identity are retained in this repository. Sources:
[historical news](https://docs.alpaca.markets/us/docs/historical-news-data) and
[streaming news schema](https://docs.alpaca.markets/us/docs/streaming-real-time-news).

SEC submissions and extracted XBRL data are public through `data.sec.gov`. The API documentation distinguishes
filing-history updates from slower extracted facts. Source:
[SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).

Scheduled macroeconomic events have primary calendars at the
[BLS](https://www.bls.gov/schedule/news_release/) and the
[Federal Reserve](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm).
Historical macroeconomic tests require vintage data. Source:
[FRED observation and vintage parameters](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).

Databento documents finite evaluation credits and separates historical access from live access and licensing.
No claim of a permanently free consolidated replacement is established here. Sources:
[Databento quickstart](https://databento.com/docs/getting-started/build-first-app) and
[live licensing](https://databento.com/live).

## Economic tests precede adoption

The first comparison remains immediate momentum, delayed momentum and Jev-filtered entry on common inputs.
It must include all scheduled opportunities, abstentions, failed model work, turnover, fees and unresolved costs.
The [incremental-value protocol](jev-incremental-audit.md) separates selection effect from delay effect.

A feed or news experiment changes one information set at a time. Freeze dates, the universe, timing rules,
execution assumptions and cost scenarios before inspecting results. Record the first locally observed version
of every external event. A later article update, amended filing or revised macroeconomic observation cannot
enter an earlier decision.

Additional sources belong in asynchronous acquisition and retained research inputs. Execution and protective
closures must not wait for a news, filing or macroeconomic HTTP request. The current IEX strategy and feed identity
remain active until a separately reviewed experiment supports a change.

Coverage improvements can justify further measurement. Adopting a paid feed requires evidence that its incremental
economic benefit survives its full cost on untouched data. Neither October 13's positive gross PAPER P&L nor
the historical coverage comparison establishes that benefit.

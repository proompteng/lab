# Testing Bayn's net trading edge

Jev's `enter` probability describes a choice in its prompt. It is not a calibrated probability of a positive
execution return. Bayn currently selects from that choice, then applies independent quote, capital and execution
controls. A stronger semantic score does not establish a larger expected profit or justify greater exposure.
TypeSafe's [confidence definition](https://docs.typesafe.ai/confidence) describes the separation of a choice's
largest probability from a uniform distribution. Test financial calibration on outcomes at the actual trading
horizon, with costs and the complete candidate denominator, before interpreting that value economically.

## Source and execution differences

Alpaca's [market-data documentation](https://docs.alpaca.markets/us/docs/market-data-faq) distinguishes a single
exchange's IEX feed from the consolidated SIP feed. Historical SIP access can be available when the requested end
is at least fifteen minutes old; this does not establish real-time SIP entitlement. Keep the requested feed explicit.
A later historical quote is a reference for an execution audit, not an original consumer arrival or a substitute for
Bayn's live information set.

Alpaca's [PAPER documentation](https://docs.alpaca.markets/us/docs/paper-trading) states that PAPER fills use NBBO
and do not check order size against displayed NBBO quantity. Its simulation also omits market impact, queue
position and latency-related slippage. Report PAPER accounting separately from executable live capacity. Do not
convert a PAPER return into a scalable capital claim or treat absent simulated expenses as zero real expenses.

Bars may be absent when no eligible trades establish their prices. Missing IEX minutes are therefore neither proof
of a consolidated-market gap nor permission to create bars. Count unique regular-session minutes, retain revisions
and source identity, and apply each study's coverage contract without silently filling holes.

## What the published strategies support

The authors' [intraday hedging-demand study](https://academicweb.nd.edu/~zda/intramom.pdf) investigates an
end-of-session momentum effect. It provides a hypothesis about horizon and market structure; it does not validate
Bayn's fixed fifteen-minute individual-stock positions.

The [SPY intraday momentum paper](https://alexandria.unisg.ch/server/api/core/bitstreams/a99aba00-f967-49b3-aceb-f544dc386e0b/content)
uses its own noise area, VWAP, exit, direction and exposure rules. Its reported returns cannot be imported into
Bayn's different portfolio and execution policy. Replication must keep its original rules and costs explicit before
testing a separately frozen Bayn variant.

The [opening-range breakout study](https://www.alexandria.unisg.ch/server/api/core/bitstreams/3c2989c4-688d-4d78-8a71-f02690990d51/content)
selects stocks using opening-range relative volume against prior sessions, with a broader historical universe,
long and short directions and different stops and holding periods. It motivates testing point-in-time activity and
candidate selection. It does not justify applying its headline results, leverage or thresholds to Bayn's fixed
candidate list. A comparable relative-volume feature needs the prior-session opening windows from the same source;
current-window volume alone does not supply that denominator.

Register these as distinct hypotheses. Record rejected trials too. Avoid tuning a sequence of live thresholds to
the same small set of observed trades and presenting the winning filter as unseen evidence.

## Economic experiment boundary

The authors' [backtest-overfitting analysis](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) explains how
selecting among trials can overfit even when individual backtests include a holdout. The
[deflated Sharpe analysis](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) additionally addresses selection
and non-normal returns. Preserve trial history, session-level uncertainty and an untouched temporal evaluation;
do not report a Bayn overfitting probability or deflated Sharpe unless those calculations actually ran on adequate data.

Use the [retained native export](study-evidence-export.md) for reproducible decision diagnostics. Include exclusions,
abstentions, pending results and cycles with no batch. Filtering only realized winners or comparing overlapping
forward labels cannot reconstruct replacement choices, order timing or portfolio cash carry.
Use [original capture](../../services/bayn/src/research-capture/README.md) for studies that require the complete
arrival and controller timeline. Retained decision snapshots do not satisfy that contract.

The [signal study](jev-signal-study.md), [matched-entry study](matched-entry-study.md),
[portfolio controls](control-portfolios.md) and [ridge training](six-bar-ridge.md) have different evidence boundaries.
An integrity pass is not an economic pass. Freeze the baseline, protocol, temporal split, source manifest and cost
assumptions before the next evaluation. Compare complete portfolios at the same capital and risk bounds, keep
zero-opportunity sessions, use causal execution labels and preserve partial fills and cash carry.

Price all four operating-cost classes: inference, data, infrastructure and research. TypeSafe's
[published model tariff](https://docs.typesafe.ai/models) is a price estimate until bound to the applicable metering
and billing period. A credit refill is prepaid balance, not session consumption. Missing receipts, failed requests,
unpriced usage and unavailable invoices remain unknown. Require positive net performance against cash and the
frozen control under the existing qualification protocol before proposing a new trading policy.

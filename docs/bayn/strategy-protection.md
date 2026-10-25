# Jev-selected trade plans and broker protection

The replacement entry path uses OpenAI Decisions API chart judgments followed by proposal-specific Jev judgments,
with code owning plan selection and execution. Protocol v24, entry state v22, batch v7, entry target v7, exit target v5,
funded exit plan v4 and position-exit policy v5 define the current source contracts. Broker protection, sizing, costs,
account risk and holding/session safeguards remain mandatory. Deployment and natural round-trip evidence remain separate.

## Model contract

The original verified numerical snapshot and deterministic candlestick image identify the same completed source bars.
OpenAI Decisions API judges support, resistance and consolidation and selects actual source-bar anchors. Presence judgments
and anchor probabilities remain explicit, including refusals. Anchors alone do not establish that a structure is present.

Code derives at most two complete proposals. Support recovery places its stop one executable tick below the identified
support and its target one tick before observed resistance. Base breakout requires the fresh bid above the identified
completed base, places its stop below that base, and projects a target one base range above it. This target is explicitly
labeled a projection. Neither proposal invents historical prices or requires an arbitrary multiplier grid.

The original request, visual receipt, source anchors, funded proposals and exact dependent Jev request form one immutable
handoff. PostgreSQL commits that handoff before dependent inference and admits at most one dependent dispatch. The final
receipt must match the committed handoff. A retry cannot resubmit either provider; late evidence remains available for
cost reporting without replacing an abandoned decision. Both stages share the original ten-second validity window.

Jev receives the visual judgments, relevant source bars, numerical context and actual proposal. It answers three independent
Nouls per proposal: whether the newest sequence confirms that setup, whether the stop invalidates it, and whether observed
overhead resistance obstructs its target. Code requires at least 0.7 support for confirmation and invalidation and at most
0.3 obstruction. Uncertain, missing or refused required judgments do not select a proposal. These thresholds are judgment
policies and have no demonstrated calibration to target-hit probability or profit.

Code ranks supported proposals by their weakest required judgment, then lower modeled loss, then stable identity. An
unsupported recovery does not veto a supported breakout, or conversely. There is no compound `action` choice or broad
setup-classification veto. Position exits follow the bound stop, profit target and holding/session deadlines in code.

The shared evidence instruction is the sole GEPA-editable string. Each atomic question retains its own fixed wording and
criteria, and the strategy protocol hash binds the actual question policy. Compiled variant tests verify that changing the
string changes outgoing questions and protocol identity while retaining native evidence reproduction.

Code funds every complete plan before inference. Target proceeds must exceed acquisition cost after modeled entry and exit
fees at the enforced take-profit sell limit. The limit is already the minimum execution price; discounting it again
would count an additional allowance that the order does not permit. State exposes `takeProfitBreakEvenLimitUsd` and
`takeProfitRequiredBidRiseBps` separately from `holdingExitBreakEvenBidUsd` and `holdingExitRequiredBidRiseBps`.
Holding-time liquidation retains the adverse quote allowance. Stop proceeds must be positive and below acquisition cost. If allocation or prices
cannot fund any plan, only abstention remains. The exact sealed request, response and deterministic reconstruction bind the
chosen plan. A missing, foreign, altered, stale or unsupported choice cannot authorize an order. Model abstention remains
explicit in `entryPlanRejections`, and public no-trade status distinguishes `JEV_MODEL_ABSTAINED` from
`JEV_NO_FUNDED_CANDIDATES` instead of describing an empty account as satisfied targets.

Quantity retains existing capital allocation and instrument precision. The funded quantity ceiling prevents a cheaper
refreshed ask from expanding it. Account loss, drawdown, turnover, notional, exposure, open-order, authority and reconciliation
limits remain enforced. The maximum holding/session deadlines and five-second protection cadence remain safeguards.
Model probabilities compare supplied alternatives; they are not calibrated probabilities of profitable trades.

Crypto entry inventory uses the taker rate for the broker account's reported `crypto_tier`, retained in the sealed
v2 account snapshot and its reconciled state hash. An unknown tier uses the maximum 25 basis points. Every future
sell continues to use that maximum, including stop and holding-time liquidation. The final writer fence reads the
entry's original sealed account evidence and refuses transmission when the freshly observed account's fee bound
exceeds that estimate. The transport clock checks the bound again immediately before submission. Observations expire
at the next 07:00 or 08:00 UTC boundary, conservatively covering both interpretations of the documented daily
03:00 Eastern tier reset. A refreshed account observation is required to retain a discount after either boundary.
See [Alpaca's crypto fee schedule](https://docs.alpaca.markets/us/docs/crypto-trading) and
[fee disclosure](https://files.alpaca.markets/disclosures/library/AlpacaCryptoLLCFeeDisclosure.pdf).

## Venue behavior

| Inventory and session                                 | Native protection                                                           | Application responsibility                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Whole-share equity entry in regular hours             | Entry LIMIT/DAY bracket binds take-profit LIMIT and stop-limit before entry | Confirm parent and both children; cancel an incomplete parent before protecting residual inventory |
| Settled whole-share equity inventory in regular hours | OCO take-profit LIMIT and stop-limit at the original prices                 | Recover ambiguous submission, verify the group and liquidate only after cancellation settles       |
| Fractional equity inventory in regular hours          | Individual STOP_LIMIT/DAY                                                   | Target, holding/session deadlines, renewal or residual close                                       |
| Crypto inventory                                      | Individual STOP_LIMIT/GTC after confirmed inventory is available            | Target and holding deadlines; cancel-confirm-reconcile before a residual LIMIT/IOC close           |
| Equity extended hours                                 | Application triggers                                                        | Alpaca advanced orders cannot supply extended-hours protection                                     |

Alpaca activates bracket children only after the parent fully fills. A partial entry therefore has a protection gap
until the parent remainder is canceled and settled inventory can be protected. Crypto cannot pre-register an equity
bracket or OCO; its strategy plan is bound before entry, while the stop is submitted after reconciled inventory is
available. A venue rejection, unavailable evidence or outage can delay that submission. Protection is armed only
when accepted broker orders prove the intended prices and remaining quantity. These constraints follow Alpaca's
[order rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca),
[order API](https://docs.alpaca.markets/us/reference/postorder),
[crypto order support](https://docs.alpaca.markets/us/docs/crypto-orders) and
[fractional trading rules](https://docs.alpaca.markets/us/docs/fractional-trading).

A stop-limit specifies a price floor, not a guaranteed execution. A gap can leave it unfilled. A rapidly moving market
can fill both group legs before cancellation takes effect. The account controller detects residual or negative
inventory through normal broker and accounting reconciliation. It does not assume that a cancel response makes an
order terminal. See [FINRA's explanation of stop-order risks](https://www.finra.org/investors/insights/stop-orders-factors-consider-during-volatile-markets).

## Durable execution

Native terms participate in the deterministic intent identity, submitted-body hash, SQL record, recovery matching and
risk evaluation. SQL verifies them against the immutable entry strategy document. Conditional sells use their sealed
trigger or target as the price reference; they remain quantity-bounded reducing orders subject to fresh final broker
authorization. Native group requests reserve their complete prospective order count. Equity protection also verifies
regular-session eligibility again at final transmission.

Nested Alpaca responses establish the generated child identities. Their account, parent, symbol, side, duration,
prices and quantities are checked against the original intent. Children and their fills enter the same reconciliation
and accounting path as ordinary orders. Partial take-profit fills reduce remaining stop coverage without repricing it.
Posted coin fees and accounted protective disposals remain distinct inventory facts. Once native protection fully
exits the account, settled protective intents, receipts and fresh exact flat reconciliation complete the cycle and
permit the next normal admission. Conditional price evidence hashes the sealed plan and current reconciliation;
it does not fabricate a current executable quote.

Before an application target, stop or deadline close, the controller cancels outstanding protective sells. A durable
per-order cancellation command records that decision before the broker call and latches the exit. Ambiguous responses
require a new reconciliation. Retrying cancellation addresses the same broker order. All protective sells must be
terminal, with fresh exact inventory and accounting, before a new close sells the residual. A filled parent does not
make its remaining children disappear. Unknown submissions are recovered by their original client identity.

Application take-profit closes preserve the sealed profit limit even if a refreshed quote falls below the trigger.
Protection cancellation stores the verified exit target with its existing durable command. Position recovery checks
the original entry, account and plan binding and retains `profitExitRequested`; releasing protection cannot erase the profit floor.
The pricing, immutable decision verifier and submission reconstruction enforce the same floor. An unfilled or partial
profit order is canceled at the actual first-fill holding deadline, including while new submissions are disabled.
Residual closes release the profit floor when the current bid crosses the original stop or holding time elapses.
Existing quote/risk expiration and cancel-confirm-reconcile requirements still apply; a profit limit never guarantees a fill.

## Hard cutover

Migration 146 requires flat, settled and fully accounted inventory with fresh exact reconciliation. It retains
immutable financial and model history, restricts new Jev authority to v23, and accepts only current account, batch and
native protection contracts for new writes. It retires prior PAPER authority through the established OBSERVE
recovery path. A new same-account mandate is bound to the verified published image before PAPER restoration.
Historical v1 account snapshots retain their original values; new observations require v2 and a nullable broker fee tier.
No legacy strategy evaluator or geometric exit fallback remains executable. Replay checkpoint v10 rejects
pre-cutover checkpoints. Broker order, fill and accounting history are preserved.

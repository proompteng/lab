# Alpaca equity hours and Bayn's execution contract

Investigation date: 2026-10-16. This concerns the existing Alpaca PAPER account and its existing data identities.

## Broker hours and entitled market data

Alpaca offers premarket from 04:00 to 09:30 ET, regular trading from 09:30 to 16:00 ET, and after-hours from
16:00 to 20:00 ET. Overnight trading bridges 20:00–04:00 from Sunday evening through Friday morning, subject
to the exchange calendar and per-asset eligibility. The current overnight documentation supports LIMIT with DAY
or GTC; an overnight DAY order can remain open through the following regular and after-hours sessions.
These are broker capabilities, not evidence that Bayn has the corresponding executable data.
[Alpaca 24/5 trading](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api).

The existing Bayn and Dorvud credentials each returned IEX data successfully and HTTP 403 for realtime SIP and
BOATS. All 16 equity-universe assets reported overnight eligibility, and overnight account access was enabled.
The current Basic data plan limits the useful IEX interval to 08:00–17:00 ET, as confirmed by Alpaca staff.
[Alpaca's IEX hours explanation](https://forum.alpaca.markets/t/real-time-data-hours/14977).

The free overnight feed supplies indicative quotes and delayed trades. It cannot substitute for Bayn's current
contract for executable quotes and observed completed-minute signals. Realtime BOATS requires Algo Trader Plus;
the inspected account subscription page offered $99 per month. The user chose to keep Basic and use its available
hours. No subscription purchase is authorized. The deployed equity interval remains 08:00–17:00 ET, subject to
the provider calendar and instrument eligibility.
[Alpaca overnight feed entitlements](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api).

## Current change

- Retain the broker's regular and extended bounds in calendar v2 and select their intersection with 08:00–17:00
  America/New_York. UTC conversion follows DST. Holidays remain absent; an early regular close does not truncate
  an extended interval that the provider still supplies.
- Keep one planner, risk evaluation, durable mutation coordinator, reconciliation loop and accounting journal.
  Stock limit orders use DAY and `extended_hours=true`; crypto limit orders retain IOC and continuous eligibility.
  These are instrument terms in the same order encoder. Extended equities cannot use the retired stock IOC contract.
- Cancel an acknowledged open order when its immutable risk approval or submission window expires. Persist cancel
  evidence and recover by broker identity; preserve partial fills and never issue a replacement submission merely
  because a response was lost. The provider's DAY lifetime does not define Bayn's permitted resting lifetime.
- Use a bounded LIMIT/DAY for whole-share equity liquidation when archive access fails. Preserve exact reconciled
  quantity, mark, authority, deadline and adverse-price allowance. Equity entries remain whole shares; the retained
  fractional-position market close requires a broker session supporting market orders.
- Compute observed and technical features separately in the 08:00, 09:30 and 16:00 clock segments. Preserve regular
  indicator arithmetic, missing minutes and corrections. The first completed minute may support observation; there
  is no additional thirty-minute admission requirement.
- Require extended-session quote delivery without treating absent prints as transport heartbeats. Keep missing
  symbol coverage visible, and retain candidate-level quote, trade, feature and risk exclusions.

Alpaca's extended-hours order constraints and asset-specific time-in-force restrictions determine the order terms.
[Alpaca order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca).

## Migration and proof

Jev protocol v7 and execution model v6 replace their prior executable versions. Migration 113 requires terminal
orders and mutations, flat settled positions, complete accounting and fresh exact reconciliation. It preserves
operator restrictions and clamps prior PAPER authority to OBSERVE. Kargo publishes and promotes the reviewed source;
verify the native OBSERVE controller, then seal and activate a new same-account PAPER mandate for that image.
Historical financial rows remain immutable audit evidence.

Acceptance requires actual broker fills, matched native receipts and TigerBeetle transfers. Successful deployment,
quote reception or a READY endpoint does not establish trading. Track BTC/USD, ETH/USD and SOL/USD independently,
including actual filled notional, fees and recovery; verify equities in a real eligible session and at the next
regular open. Missing inference usage or pending fee receipts remain incomplete cost evidence. The frozen Jev
comparison additionally requires its original captures and registration; synthetic fixtures cannot replace them.

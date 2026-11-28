# Daily next-open macro canary ETF runner

This is a standalone **Alpaca Paper qualification** tool, not a Bayn live strategy, scheduler, approval or
accounting integration. [Wave 5D](https://github.com/proompteng/lab/pull/16376) reported that its frozen base
ensemble passed the strict retrospective split tests at 2/5/10 bp; no configuration passed full qualification.
Keep one receipt for every eligible prospective session, including sessions with zero orders. A receipt does
not establish fills, qualified performance, or authority to trade real capital.

## Run it

Supply `BAYN_ALPACA_KEY_ID` and `BAYN_ALPACA_SECRET_KEY` from the intended **paper** account with SIP access.
`BAYN_ALPACA_BASE_URL` defaults to `https://paper-api.alpaca.markets` and cannot select another origin.
The separate data origin is fixed to `https://data.alpaca.markets`. Put output in a private directory on
durable storage. From the repository root:

```sh
bun services/bayn/tools/run-macro-canary-etf-rebalance.ts \
  --output /private/receipts/next-open-shadow.json \
  --exclude-symbols QQQ,SMH --capital-budget-usd 50000
```

The runner accepts observations from 20:15 New York time on the last completed session through two minutes
before the next regular open, when the broker clock and calendar agree. Running before the open on the
execution date is the normal daily operating window; holidays and early closes follow the broker calendar.
Use a new receipt file for each observation; the command never overwrites one.

To send the verified plan to the intended paper account, use a new output path and add
`--mode paper-submit --confirm-paper-account <paper-account-uuid>`. The default `--tif opg` is an opening-auction
limit. `--tif day` instead queues a regular-session limit that can execute later in the session. Neither
permits extended-hours fills. See [Alpaca's order rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca).

## What is reproduced

- [Historical SIP bars](https://docs.alpaca.markets/us/reference/stockbars) must cover exactly the last 320 sessions for
  all 27 ETFs, including DIA and UUP, with `adjustment=all`. Six macro inputs before that window seed the 63-session
  regime EMA from the original study anchor (2016-01-04). The New York session timestamp, exact coverage, payload and
  pagination must all validate. No current-session bar or data fallback is used.
- The 21-session base review is anchored to the 252nd return in the same study calendar. On other days the receipt
  shows current diagnostics and the last reviewed target without emitting orders. The receipt includes breadth
  protection, 13612W scores, continuous TSMOM scores, macro factors/quadrant, sleeve targets, risk budgets and SHY carry.
- The planner uses **raw** SIP closes from the last completed session, not adjusted prices or predicted opening
  prices. It uses a ten-percentage-point absolute drift band (rather than the study's five-point execution band).
  It leaves the portfolio unchanged within the band and, on a rebalance, puts remaining in-sleeve weight into SHY
  without sweeping excluded allocations. It uses whole shares and buy/sell limits rounded inside the 15 bp collar.
  Partials, unfilled orders, unavailable cash and splits effective after the sizing close can leave realized
  exposure different from the plan. Turnover is half the gross buy-plus-sell reference notional divided by pretrade
  equity; limit notionals are reported separately.

## Shared paper account and recovery

Use an exclusion list or an explicit budget on a shared account. Either option reserves QQQ and SMH for the Noise Area
sleeve. Include any other shared symbols in the exclusions: the runner otherwise treats in-universe long positions as its
own. It reserves gross for excluded and out-of-universe holdings, and never adds exposure based on expected sales or
margin. The receipt shows the conservative current-mark + pending-buy gross against the $150,000 overnight cap and the
remaining room under the $180,000 intraday cap. The other account writer must respect that remaining room and stay idle
through submission. This standalone CLI cannot fence independent broker writers or cap later mark-to-market changes.

Paper submission refuses any outstanding account order because it could change available shares, cash or gross.
Before dispatch it checks for prior same-session orders (including terminal orders), verifies that the account and
inventory have not changed, and rechecks the broker clock. Keep all paper output in **one directory per account**
on a single writer: the exclusive `bayn-mc-…-submissions.jsonl` journal is an account/session fence. Every dispatch is
journaled before POST, every verified acknowledgement afterward. If a dispatch has no acknowledgement, reconcile
by its client order ID in Alpaca before taking further action. The runner stops at the first uncertain response;
it does not retry, cancel, or roll back any earlier order. An acknowledgement is not proof of fill.

The canonical `bayn.macro-canary-rebalance-receipt.v1` JSON includes `barSha256` over the decoded, sorted adjusted
SIP observations (including the macro seed). `planSha256` covers the canonical receipt excluding the execution
mode, observation timestamp and the digest field itself. That keeps identical shadow and paper plans comparable
without logging credentials. Receipts contain private paper balances and inventory; do not publish them.

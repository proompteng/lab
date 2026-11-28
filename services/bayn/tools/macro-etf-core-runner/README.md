# Daily Next-Open macro ETF core runner

This is a standalone **Alpaca Paper** tool for prospective shadow and paper observations. It does not register a
strategy, deploy a service, write to Bayn's ledger, or grant live capital authority. Run it once per eligible session,
including non-review days. A receipt or broker acknowledgement is not proof of fills or forward profitability.

## Run it

Provide `BAYN_ALPACA_KEY_ID` and `BAYN_ALPACA_SECRET_KEY` from the intended paper account with SIP access.
`BAYN_ALPACA_BASE_URL` defaults to `https://paper-api.alpaca.markets`; live endpoints, lookalikes, and redirects are
not allowed. Market data is fetched only from `https://data.alpaca.markets`. From the repository root:

```sh
# Shadow is the default. Use a new receipt path on each run.
bun services/bayn/tools/run-macro-etf-core-rebalance.ts \
  --profile F4 --exclude-symbols QQQ,SMH --capital-budget-usd 50000 \
  --output /private/bayn-paper/next-open-shadow.json

# After confirming the paper account, use a different receipt path.
# Set PAPER_ACCOUNT_UUID to the intended Alpaca Paper account's UUID.
bun services/bayn/tools/run-macro-etf-core-rebalance.ts \
  --profile F4 --exclude-symbols QQQ,SMH --capital-budget-usd 50000 \
  --output /private/bayn-paper/next-open-paper.json \
  --tif opg --mode paper-submit --confirm-paper-account "${PAPER_ACCOUNT_UUID}"
```

The window is **20:15 ET on the last completed session to 09:28 ET (exclusive) before the next regular open**.
The broker calendar and clock must agree, including after holidays and early closes. Run early enough for the
market read, reconciliation, and dispatch to finish before cutoff. The default `--tif opg` is a limit for the
opening auction. `--tif day` may fill later in the intended regular session. Neither permits extended-hours fills.
See [Alpaca order rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca).

## Profiles and evidence

- **F4** (default) is Wave 5C's fixed risk-parity, credit/haven and carry blend. In
  [Wave 8A's 2016–2026 replay](../../../../docs/bayn/evidence/2026-11-27-macro-etf-core-dual-horizon/README.md),
  its 0.83× annual turnover kept friction low: at 10 bp one-way (20 bp round-trip), it beat SHY in all three
  splits, ending at $197,817 on $100,000 with 6.46% CAGR, Sharpe 1.21, and 9.81% max drawdown.
- **F2** is the HYG/IEF EMA100 credit/haven selector. At the same stress tier, its 1.84× annual turnover
  still left it ahead of SHY in all three splits: $276,319 terminal equity, 9.78% CAGR, and +1.15% in 2022.
  These are historical results for the registered research books, not a forecast or a measurement of this CLI's collars,
  exclusions, or fill rate.
- **F2_F4_EQUAL** averages the two target vectors 50/50 on their common cadence before applying exclusions
  and SHY carry. All profiles use the direct [Wave 8A policy and signal implementation](https://github.com/proompteng/lab/pull/16391):
  a 100-close warmup and one review every 42 sessions anchored to 2016-01-04. No review means no target or orders.

The runner requires calendar-aligned, ordered [SIP daily history](https://docs.alpaca.markets/us/reference/stockbars)
requested with `adjustment=all`, and independently requests the finalized review close with `adjustment=raw` for sizing.
Alpaca's daily timestamp labels the session at New York midnight, not the publication time. Signal evidence uses
the conservative 20:15 ET finalization boundary and the observed broker clock, not a provider publication timestamp.
Required gaps and malformed, duplicate, out-of-order, or out-of-window rows stop the run. XLC and XLRE may have
missing closes: a gap resets the strategy's 20-close eligibility counter, and a candidate missing on the review
session has zero emitted weight and no orders. Raw closes are mandatory for every symbol with a valid review close.
No data fallback is used.

The planner uses the larger of aggregate buy drift and sell drift against the sleeve budget, with no discretionary
rebalances below 10%. It sizes whole-share limits using the raw preceding close and rounds inside a 15 bp collar.
Buys must fit within available cash, buying power, and gross **without counting proceeds or gross released by sells**.
This is a pre-open limit plan, not the research planner's simulation of a known open. Partials, unfilled orders,
splits effective after the sizing close, and price moves can change realized exposure.

## Coexistence and recovery

QQQ and SMH are protected by default and always protected in paper-submit for Bayn v3's 30-minute, 1.4× Noise Area sleeve.
On the dedicated paper account only, `--mode shadow --exclude-symbols ""` permits the full F4 allocation after Alpaca
matches `BAYN_MACRO_CORE_ALPACA_ACCOUNT_ID`; this path uses only the matching scoped key and secret.
Otherwise `--exclude-symbols` adds protection
for other shared symbols; it cannot remove those two. Excluded symbols have zero target and are never bought, sold, or
modified. Their offense weight goes to eligible peers within the same group, proportional to their existing targets (or
equally if those targets are all zero). Non-offense exclusions and allocations with no eligible peers go to SHY, or to
cash when SHY is excluded. Excluded, unavailable optional, and out-of-universe holdings reserve gross using the worse of
absolute broker market value and raw close valuation when available. In-universe long positions not protected this way
are treated as owned by the macro sleeve.

The `--capital-budget-usd` ceiling defaults to $150,000 and is further reduced by account equity and reserved gross.
The receipt reports projected gross including pending buys against the $150,000 overnight and $180,000 intraday caps.
Another account writer must respect the remaining intraday room and stay idle during reconciliation and dispatch.
The CLI cannot fence an independent writer or enforce later mark-to-market exposure.

Keep all paper output in **one private, durable directory per account**, with one account writer. Receipts and journals
are exclusive new files (mode 0600); do not publish them. The receipt's `bayn.macro-etf-core-rebalance-receipt.v1` JSON
includes `barSha256` over the calendar and canonical adjusted/raw observations. `planSha256` binds the market evidence,
targets, reconciled book and orders; it excludes observation time and mode so identical shadow and paper plans match.

Paper-submit rejects open orders, any account order since the previous close (including terminal orders), broker state
drift, and missed cutoffs. The account/session journal is shared across profiles and is claimed before the first POST.
Each exact request is flushed before dispatch; each verified acknowledgement is flushed afterward. A dispatch without an
acknowledgement is **uncertain**, even if the CLI reports a timeout or crash. Stop and look up the recorded
`client_order_id` in Alpaca before taking any further action. Do not remove the journal or switch directories to bypass
the fence. The CLI does not retry, cancel, or roll back any order.

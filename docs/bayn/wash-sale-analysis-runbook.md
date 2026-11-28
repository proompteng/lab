# Bayn wash-sale exposure and turnover tax drag

Run this offline to estimate how same-symbol wash sales and short-term taxes affect realized P&L for the B0 intraday,
F4 daily, and O1 overnight sleeves. It reads one local JSON file, prints to stdout, and never calls a broker,
database, or other service. It cannot change orders, cost basis at the broker, or capital authority.

```sh
bun services/bayn/tools/analyze-wash-sale-exposure.ts --fixture /private/fills.json --format markdown
bun services/bayn/tools/analyze-wash-sale-exposure.ts --fixture /private/fills.json --format json
```

Markdown is the default. JSON (`bayn.wash-sale-exposure-report.v1`) includes every realized lot slice, wash match
and open lot slice; use it to reconcile fills or compare scenario rates. Both reports are deterministic for the
same ledger and rates. A bad argument, unreadable file, invalid schema, or unsupported inventory fails with a
nonzero exit and no report. Errors go to stderr with redacted causes; a fill number, if present, is the 1-based
position in the input `fills` array.

## Prepare the ledger

1. Supply one taxpayer's reconciled taxable, long-only USD equity/ETF fills across the relevant accounts and
   sleeves. Start from verified flat inventory, with no carried wash basis. Include pre-year history to reconstruct
   inventory and any incoming wash adjustments; a report clipped to January 1 may be missing both. Do not run
   separate ledgers per sleeve or account when they share a tax owner: doing so misses replacements.
2. Set `observedThrough` to the last **complete** New York calendar date covered by the export. Include all fills on
   that date, not just regular-session fills. `taxYear` selects sales and turnover from January 1 through the earlier
   of that cut or December 31. For year-end analysis, include the next 30 calendar days across accounts to close
   the December sale windows. The program cannot verify that an export omitted no activity.
3. Set both flat scenario rates explicitly in integer basis points (0–10,000). Use consistent uppercase symbols
   and stable, non-sensitive account and fill aliases. Each buy row represents one distinct acquisition lot; use
   broker lot evidence rather than treating several execution fragments of the same purchase as new acquisitions.
   Do not include raw account numbers, credentials, or other sensitive fields. Keep the ledger and its report in
   approved private storage.

The ledger below uses synthetic fills. `at` is the UTC execution timestamp (up to nine fractional digits, `Z`);
same-symbol fills must have distinct instants, so the order is not guessed. Array order does not matter. Quantity
and per-share price are positive decimal integer strings in billionths of a share and of USD respectively.
`feeMicros` is a nonnegative decimal integer string in millionths of USD; `"0"` means the verified fill fee was zero.
`specificLots` is optional on sales only: when present, provide distinct `{ "buyFillId": ..., "quantityAtoms": ... }`
entries from that sale's account and symbol covering exactly the sold quantity. Use it only for broker-confirmed
specific identification. With no such evidence, omit the field to use FIFO.

```json
{
  "schemaVersion": "bayn.wash-sale-fill-ledger.v1",
  "taxYear": 2026,
  "observedThrough": "2026-08-30",
  "shortTermRateBps": 3000,
  "longTermRateBps": 1500,
  "fills": [
    {
      "id": "b0-buy",
      "accountId": "acct-b",
      "sleeve": "B0",
      "symbol": "QQQ",
      "side": "BUY",
      "at": "2026-07-31T14:30:00Z",
      "quantityAtoms": "2000000000",
      "priceAtoms": "100000000000",
      "feeMicros": "0"
    },
    {
      "id": "b0-sell",
      "accountId": "acct-b",
      "sleeve": "B0",
      "symbol": "QQQ",
      "side": "SELL",
      "at": "2026-07-31T15:00:00Z",
      "quantityAtoms": "2000000000",
      "priceAtoms": "80000000000",
      "feeMicros": "0"
    },
    {
      "id": "o1-buy",
      "accountId": "acct-o",
      "sleeve": "O1",
      "symbol": "SMH",
      "side": "BUY",
      "at": "2026-08-21T19:55:00Z",
      "quantityAtoms": "1000000000",
      "priceAtoms": "100000000000",
      "feeMicros": "0"
    },
    {
      "id": "o1-sell",
      "accountId": "acct-o",
      "sleeve": "O1",
      "symbol": "SMH",
      "side": "SELL",
      "at": "2026-08-24T13:30:00Z",
      "quantityAtoms": "1000000000",
      "priceAtoms": "150000000000",
      "feeMicros": "0"
    },
    {
      "id": "f4-buy",
      "accountId": "acct-f",
      "sleeve": "F4",
      "symbol": "QQQ",
      "side": "BUY",
      "at": "2026-08-28T15:00:00Z",
      "quantityAtoms": "1000000000",
      "priceAtoms": "90000000000",
      "feeMicros": "0"
    }
  ]
}
```

The B0 sale loses $40, but the F4 buy replaces only one of the two shares. It defers $20 and raises that share's
basis from $90 to $110. The other $20 is not matched, and the window has closed. The O1 sale contributes a $50
gain. The ledger has $10 pre-tax realized P&L, $30 observed short-term tax P&L, $9 estimated short-term tax, and
$1 post-tax realized P&L. Short-term tax drag is 128.57 bps of the **$700 two-sided gross traded notional**, not
of account equity or realized P&L. The one-share replacement is what limits the deferral; the 3,000 bps
scenario rate drives the $9 estimate.

## Interpret and reconcile

- **Realized P&L:** sale proceeds less sale fees and the original acquisition cost including buy fees. Lot
  selection stays within the selling account and symbol; the sale belongs to the selling sleeve. A matched
  portion of a buy lot has its own basis and holding period and is consumed before its unmatched remainder.
- **Wash-sale basis:** within the inclusive 30-calendar-day lookback and lookahead, match by acquisition order
  to same-symbol replacement shares across the ledger. Pre-sale shares must still be held after the sale;
  retained shares from the very same acquisition cannot replace their own loss. Each replacement share is used
  once, and a loss on its adjusted basis can be deferred into a later acquisition. Prior holding periods tack
  onto matched shares; exactly one year is still short-term.
- **New versus carried deferrals:** observed tax P&L is pre-tax P&L minus prior wash basis used plus newly
  deferred loss. New deferrals can include re-deferred amounts. `openLots` shows basis still carried at
  `observedThrough`, not necessarily at year end. Open lots are not marked to market.
- **Pending windows:** `pendingWashSaleLossMicros` is the unmatched loss that more observed purchases could defer.
  When an unmatched loss has not had its full lookahead, observed tax P&L includes only known matches. Tax,
  post-tax P&L, and drag are withheld for that summary, not reported as zero. Extend the cut to the last
  applicable `windowEndsOn` (inclusive) and rerun. A complete window means complete relative to the supplied
  ledger, not proof of coverage outside it.
- **Tax and turnover:** net short- and long-term results within the reporting year, offset opposite-sign
  balances, and apply the supplied rates to positive remainders. Do not impute a tax credit for net losses.
  Post-tax P&L subtracts that tax from economic P&L, not from taxable P&L. Sleeve, symbol, and pair estimates
  are standalone; they need not add to the full-ledger estimate because of netting. The drag numerator is
  estimated short-term tax; its denominator is the sum of gross buy and sell notional in the same row and
  period, excluding fees. No notional means no ratio. The tool does not annualize or infer equity.
- **Precision:** replay uses integer arithmetic with 18 decimals for USD amounts. Fee and amount allocation
  leave rounding remainder with the last slice. JSON money is signed integer microdollars, truncated toward
  zero from the unrounded result; displayed detail can differ from a total by rounding. Drag is truncated to
  two decimal places.

This is an exposure scenario, not tax advice or a filing worksheet. It does not infer substantially identical
securities across different tickers, activity outside supplied accounts (including related accounts and IRAs),
opening basis without the acquisition history, short sales, options, corporate actions, transfers, income,
distributions, other gains/losses, carryovers, or graduated tax brackets. Review those separately before treating
results as tax evidence. References: [IRS Publication 550](https://www.irs.gov/publications/p550),
[26 CFR § 1.1091-1](https://www.govinfo.gov/content/pkg/CFR-2025-title26-vol13/xhtml/CFR-2025-title26-vol13-sec1-1091-1.html),
[26 USC § 1223](https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapP-partIII-sec1223.htm).

# Torghut Profit Candidate Board - 2026-05-19

## Purpose

Keep the current `$500/day` profitability search state explicit enough that candidates are not recycled without their
blockers. This board is an operating record, not a promotion certificate.

## Current Answer

There is no promotion-ready `$500/day` candidate at this snapshot.

The current best research candidate is `H-TSMOM-01` / `spec-83161ae16d17828eabcc58cc`, family
`intraday_tsmom_v2`, runtime strategy `intraday-tsmom-profit-v3`. It ranked first in the latest checked production
proposal-score epoch queried during this pass:

- epoch: `whitepaper-autoresearch-scaled32-20260517T182850Z`
- rank: `1`
- proposal score: `2.52157822`
- ranker backend: `numpy-fallback`
- ranker model: `mlx-ranker-v1-3505c769d4b943e1`

That makes it the candidate to keep testing first. It does not make it eligible for live promotion.

## Candidate Board

| Candidate                                                      | Current role                                                   | Evidence                                                                                          | Status            | Why it is not promoted                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `H-TSMOM-01` / `spec-83161ae16d17828eabcc58cc`                 | Best current research candidate                                | Latest production proposal-score rank `1`, score `2.52157822`; runtime `intraday-tsmom-profit-v3` | Blocked           | Live/paper metric windows queried for this hypothesis showed zero decisions, zero trades, and zero orders. It needs fresh nonzero executable replay or shadow evidence before promotion.                                                                                                  |
| `H-TSMOM-LIQ-01`                                               | Best checked-in short replay                                   | Candidate config records post-cost net PnL/day about `$412.636` over four trading days            | Blocked           | Below the `$500/day` target and explicitly marked `blocked_requires_chip_universe_replay`; previous evidence used mixed universe and requires fresh empirical promotion evidence.                                                                                                         |
| `port-25b491c263990247f50a542d`                                | Highest raw historical portfolio PnL row found in the DB query | Portfolio row showed about `$9,373.616/day` over two trading days                                 | Rejected artifact | Oracle failed. The window is too small and concentrated, with blockers including positive-day ratio, minimum daily net PnL, best-day share, single-symbol contribution, worst-day loss, max drawdown, missing executable replay, missing shadow parity, and buying-power/notional checks. |
| `H-MICRO-01` / `chip-paper-microbar-composite@execution-proof` | Only queried runtime row with actual decisions/trades/orders   | Three paper windows, seven decisions/trades/orders, average post-cost expectancy about `8.02` bps | Needs more proof  | It has real activity, but the sample is too small and does not prove portfolio-level `$500/day` post-cost net PnL.                                                                                                                                                                        |

## Promotion Rule

Do not promote a candidate just because it ranks well, has a large two-day raw PnL row, or appears repeatedly in
autoresearch output. Promotion requires current, post-cost, nonzero executable evidence with enough observed trading
days and no oracle blockers.

The governing hardening now requires:

- at least `20` observed trading days by default in the profit-target oracle;
- a measured train/test temporal embargo with at least a one-day gap for validation windows;
- no missing train/test validation windows;
- no overlapping train/test windows;
- post-cost oracle checks to remain fail-closed when executable replay or shadow parity proof is absent.

## Next Work

The next implementation work should focus on converting the best candidates into current executable proof rather than
minting more static candidates:

1. Run a fresh nonzero replay/shadow proof lane for `H-TSMOM-01` / `spec-83161ae16d17828eabcc58cc`.
2. Investigate the microstructure lane behind `H-MICRO-01`, because it is the only queried lane with real decision and
   order activity.
3. Add cost-shock and nonlinear market-impact stress to the promotion oracle so raw rank scores are punished when
   liquidity, slippage, or quote-quality assumptions are fragile.
4. Keep live promotion disabled until the runtime reports at least one promotion-eligible hypothesis and the
   profitability oracle passes with current evidence.

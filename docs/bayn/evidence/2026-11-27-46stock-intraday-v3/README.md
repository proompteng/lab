# Wave 3B: 46-stock SIP intraday synthesis

**No promotion.** None of 60 two-engine or 240 three-engine portfolios had positive Net **and**
Ex-Top-5 at both 5 and 10 bp round trip in all three splits. The Train-leading three-engine book earned
**$26,523** net at 10 bp and had five positive half-years. Its Validation profit of **$1,305** became
**−$3,425** without the five best days. No v3 strategy primitives were added; the live v2 policy hash
and migrations 0222/0223 are unchanged.

Wave 2C ([#16361](https://github.com/proompteng/lab/pull/16361)) and Wave 2D
([#16360](https://github.com/proompteng/lab/pull/16360)) inspected the **same 2024–2026 archive,
including this Holdout**. This is a disciplined synthesis check, not an unseen prospective sample.
DSR uses **2,787 cumulative registered trials**: 347 from Wave 2C, 2,055 from Wave 2D and 385 here.
The [development freeze](freeze.json) was pushed in
[`8a9f13650`](https://github.com/proompteng/lab/commit/8a9f136507bc0e37da9e36df152a232d818334fa)
before scoring Holdout. It nominated no configurations; Holdout rows are descriptive only.

## Which mechanisms helped?

- **OR5 breadth reduced concentration in dollars but also reduced returns.** The Wave 2D control
  (K=1, RVOL 2.5, 2R) reproduced about **$41.6k / $35.3k** full-window net at 5/10 bp, with 10 bp net
  positive in all three splits. Negative Validation and Holdout Ex-Top-5 persisted. The best net at
  10 bp for K=2 was **$11,785** (RVOL 3.0, 3R), and K=3 was **$9,701** (RVOL 2.5, 2R), versus
  **$37,876** for K=1 (RVOL 2.5, 3R). No K=2 or K=3 variant cleared Validation or Holdout Ex-Top-5 at
  both stresses, or preserved the $35k–$45k full-window 10 bp target.
- **Dispersion rescued untrimmed 10 bp reversion economics, not the split gates.** The noon
  100 bp IQR filter with 500/800 bp exits traded **212** sessions versus **714** ungated and took
  full-window 10 bp net from **−$450** to **+$31,345**. The timed-flat version reached **+$37,801**.
  Both had positive untrimmed net in each split and all six half-years at 5 and 10 bp. At 10 bp their
  Train Ex-Top-5 was **−$701 / −$780** (brackets / timed); Validation was **−$8,693 / −$14,604**.
  None of the 54 timing/exit/gate configurations passed Train or Validation. The closest to positive
  Validation at 10 bp was the 12:30 600 bp spread/timed variant (**−$285**), with only ten active days
  across the whole window. The ungated control is not byte-equivalent to Wave 2C: this study requires
  consecutive complete prior sessions and reserves gross at adverse opening prices. In Wave 2C,
  split net was positive at 5 bp, but Train and Validation Ex-Top-5 were already negative.
- **QQQ/SMH was a low-correlation diversifier, not a Validation fix.** The 1.2-band opposite-exit
  control returned **$17,457 / $4,312** at 5/10 bp full-window. In the Train-leading three-engine book
  the full-window 10 bp daily standalone sleeve correlations were **−0.085** (OR5/reversion),
  **+0.041** (OR5/Noise Area) and **−0.080** (reversion/Noise Area). Adding Noise Area did not get
  any allocation mode through Validation. The best 10 bp Validation Ex-Top-5 remained **−$217**
  for two engines and **−$1,387** for three; neither observation changes the freeze.

## Combined book comparisons

Counts below require positive Net and Ex-Top-5 at both stresses within the named split. The same
variant must pass all splits to qualify. The Train-only shortlist had three OR5 and four reversion
variants; each three-engine mode also crossed the four Noise Area variants.

| Allocation                                      | E1+E2 Train / Val / Holdout (12 per mode) | E1+E2+E3 Train / Val / Holdout (48 per mode) |
| ----------------------------------------------- | ----------------------------------------: | -------------------------------------------: |
| Equal static                                    |                                 9 / 0 / 4 |                                  36 / 0 / 17 |
| OR5 tilt                                        |                                12 / 0 / 8 |                                  38 / 0 / 26 |
| Reversion tilt                                  |                                 9 / 0 / 1 |                                   36 / 0 / 8 |
| Lagged inverse variance (Moreira–Muir-inspired) |                                12 / 0 / 0 |                                   44 / 0 / 0 |
| Lagged inverse-volatility risk parity           |                                12 / 0 / 7 |                                   40 / 0 / 8 |

The table below compares the highest **Train** 10 bp Ex-Top-5 in each engine-count family, not
Holdout winners. Both use OR5 top-1/RVOL 2.5/2R and noon IQR ≥100 bp/timed EOD with the static
OR5 tilt. The third sleeve is 30m QQQ+SMH band 1.2/opposite exit. Values are USD, rounded, shown as
**5 bp / 10 bp**; the sell fee is included.

| Window                | Sessions |    Two-engine net | Two-engine Ex-Top-5 |  Three-engine net | Three-engine Ex-Top-5 |
| --------------------- | -------: | ----------------: | ------------------: | ----------------: | --------------------: |
| Train                 |      374 | +26,453 / +22,465 |   +18,657 / +14,774 | +22,384 / +17,606 |     +16,348 / +11,695 |
| Validation            |      189 |   +5,981 / +3,479 |       −840 / −3,206 |   +4,333 / +1,305 |         −522 / −3,425 |
| Holdout               |      166 |  +11,477 / +8,492 |     +4,000 / +1,150 |  +10,930 / +7,613 |       +4,811 / +1,640 |
| 2024H1                |      124 |   +8,949 / +7,969 |       +1,372 / +487 |   +6,082 / +4,707 |         +1,031 / −248 |
| 2024H2                |      128 | +15,303 / +13,777 |     +7,854 / +6,431 | +11,976 / +10,180 |       +7,026 / +5,332 |
| 2025H1                |      122 |     +2,201 / +719 |     −4,824 / −6,191 |   +4,326 / +2,718 |       −1,572 / −3,061 |
| 2025H2                |      128 |      +1,379 / −19 |     −5,320 / −6,592 |     +678 / −1,106 |       −4,042 / −5,695 |
| 2026H1                |      123 |   +7,626 / +5,266 |       +1,390 / −833 |   +6,971 / +4,304 |         +1,675 / −840 |
| 2026H2 through Nov 25 |      104 |   +8,453 / +6,724 |       +1,853 / +243 |   +7,615 / +5,720 |         +2,173 / +404 |
| Full                  |      729 | +43,911 / +34,436 |   +35,504 / +26,169 | +37,648 / +26,523 |     +30,802 / +19,818 |

For that three-engine variant at 10 bp, full-window annualized Sharpe was **1.46**, MaxDD **$4,582**,
Calmar **2.00**, breakeven **21.92 bp**, Ex-Top-10 **+$14,389**, and worst LOSO was **+$20,108**
without SMCI (48/48 omissions positive). The 10,000-draw block-bootstrap p-value was **0.0060**; cumulative
DSR was **0.0000331**. Holdout Ex-Top-10 was **−$2,847**. Those metrics support neither a concentration-robust
edge in every split nor a prospective claim.

## Evidence and reproduction

- [Protocol](protocol.md) specifies the weights, the chronological gates and the bar-fill limitations.
  [Results](results.json) contain all 385 trial definitions and metrics at 2/5/10 bp, with coverage, per-window
  worst LOSO including complete-case counts, cumulative DSR, and paired daily correlations for the combined
  variants. Rows use the labeled `windowOrder`, `costOrder`, and column arrays. A null metric is undefined
  or incomplete, never a fabricated zero.
- Verified **3,923,737** authenticated source rows; **3,480,548** regular-way RTH bars remained after removing
  **442,813** out-of-session rows and **376** SNDK when-issued rows. The calendar has **729** sessions,
  including six early closes; **256** expected regular slots were absent and were not filled. No registered
  main ledger had an unresolved exit. The largest reserved concurrent gross was **$180,000**. This is an
  entry-notional cap, not continuous deleveraging after price moves.
- Use the existing artifact credentials with the committed receipt from the repository root. No raw tape
  is written to disk; no source dataset or credentials are committed. The score command independently
  reproduced the development receipt before generating Holdout trades.

```sh
cli=services/bayn/tools/research-46stock-intraday-v3.ts
evidence=docs/bayn/evidence/2026-11-27-46stock-intraday-v3
scratch=$(mktemp -d)
bun "$cli" --freeze --output "$scratch/freeze.json"
bun "$cli" --score --output "$scratch/results.json"
bunx oxfmt "$scratch/freeze.json" "$scratch/results.json"
cmp "$evidence/freeze.json" "$scratch/freeze.json"
cmp "$evidence/results.json" "$scratch/results.json"
```

The archive and cost scenarios do not establish historical executable quotes, borrow, fills, or market impact.
A prospective claim needs a new, untouched sample and execution evidence, not more selection on these dates.

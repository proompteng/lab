# Wave 2F | Consolidated SIP pairs and gap drift

**Do not advance a v3 candidate.** None of the 230 registered configurations delivered positive 10 bp P&L
**and** positive P&L after excluding the five best days in all three chronological windows. No frozen
candidate passed development or qualified after the holdout. No strategy module, live policy, migration,
broker setting, or capital authority changed.

## Frozen candidates

Dollar P&L after costs, rounded to the nearest dollar. Candidate selection ranked Train only. No substitute
was promoted after Validation or Holdout.

| Engine / frozen trial                  |             Train 10 bp | Validation 10 bp |    Holdout 2 / 5 / 10 bp | Holdout Ex-Top-5, 10 bp | Holdout bootstrap p | Holdout DSR |
| -------------------------------------- | ----------------------: | ---------------: | -----------------------: | ----------------------: | ------------------: | ----------: |
| Intraday pairs                         | No eligible Train trial |                — |                        — |                       — |                   — |           — |
| Swing pairs · 20d, 2.5z, half-life, 3d |                  $3,840 |             $434 | $3,770 / $2,953 / $1,593 |                 −$3,208 |              0.3444 |      0.0323 |
| Intraday gap · 2 ATR, 5m RVOL          |                    $729 |            −$867 |        $158 / $127 / $76 |                   −$403 |              0.3788 |      0.0003 |
| Swing gap · 2 ATR, 2d                  |                  $1,743 |             −$86 |       $432 / $377 / $284 |                   −$503 |              0.3370 |      0.0361 |
| Exhaustion fade · prior-close target   |                     $17 |             $209 |           $66 / $45 / $9 |                   −$246 |              0.4706 |      0.0001 |

The frozen swing-pairs candidate was positive at all three stresses in holdout, but failed Ex-Top-5 in
**every** split. Its holdout also failed bootstrap, DSR, parameter plateau and at least one leave-one-pair-out
omission. Five nonqualifying swing-pairs configurations were positive in holdout at 5 and 10 bp even after
excluding their top five days; none met the three-split economic requirement. Treat them as diagnostics, not as a
second selection round. Twelve intraday-pairs trials had an unsupported development window due to missing
synchronized execution; the six with complete evidence were not positive in all splits.

The daily gap replay uses a completed full-day volume/candle proxy; the intraday replay uses actual opening SIP
volume. Neither dataset has timestamped earnings surprises. The nominal 50-name core includes four ETFs:
46 stocks form the qualifying universe; the separate 49-tradable-name sensitivity also admits three ETFs,
while SPY is reserved for hedging in both cohorts. This is evidence about the registered _gap_ signals, not a
rejection of event-labelled PEAD.

## Coverage and execution checks

- Verified and ingested both immutable archives: 87,727 daily rows and 3,923,737 raw five-minute rows across 62
  names. The usable calendars contain 1,482 daily and 729 intraday sessions. Removed 442,813 non-RTH five-minute
  rows using the exchange calendar, before applying listing restrictions. The verified calendar is at the sibling
  dataset prefix; see [the protocol](PROTOCOL.md). No temporary decompressed archive was created.
- The full grid contains 14,370 trial/cost/window outcomes and 374,316 omission/window outcomes. Failed or
  unresolved execution is reported explicitly, not zeroed. Every frozen candidate's Train and Validation
  metrics match the development-only receipt.
- All swing-pairs trials stayed below $180,000 at observed rebalancing opens. Across the grid, passive price
  drift put nine trial-session closing marks above the cap (maximum $200,044; the most gross at a synchronized
  opening rebalance was $172,174). The frozen swing candidate had no such breach and a −0.016 frozen-holdout
  daily SPY beta. The modeled cap is a constraint on rebalancing orders, not a guarantee against between-fill
  exposure drift. The intraday `maxPostOpenGross` is summed last-fill inventory for each session, not a measure
  of peak intraday exposure.

## Reproduce

Run from the repository root with the existing `agents-artifacts` credentials. Both commands require a new output
path; `--score` requires the exact committed receipt and verifies it before loading holdout bars.

```sh
tool=services/bayn/tools/research-3yr-sip-pairs-ou-pead.ts
evidence=docs/bayn/evidence/2026-11-27-3yr-sip-pairs-ou-pead
bun "$tool" --freeze /tmp/wave2f-development-reproduction.json
cmp /tmp/wave2f-development-reproduction.json "$evidence/freeze.json"
bun "$tool" --score "$evidence/freeze.json" /tmp/wave2f-score-reproduction.json
cmp /tmp/wave2f-score-reproduction.json "$evidence/results.json"
```

- [Pre-registered protocol](PROTOCOL.md)
- [Development-only freeze](freeze.json), committed at `31dd7d0c219d7a7dd37159d3ff80e39088e55542`
- [Complete results](results.json): each panel's `ranges` and `metricColumns` index the result arrays; omitted
  symbol/pair entries use `leaveOutColumns`. SHA-256:
  `4cea00674f453b8620b87b562af43c0728ab647db6904745b6194fe09795e352`.

The initial holdout was scored only after the original development receipt was committed at
`47b2702ed7f905399190ff72b57cc1b74dfd31fb`. During review, a synthetic regression exposed that a missing
candidate bar could hide a protective stop. The fix invalidates the affected session and liquidates at the
next synchronized open. The corrected receipt was committed before rescoring; no parameters, candidate IDs,
development metrics, or holdout trial outcomes changed.

# Bayn hybrid HF v5: retained historical search outputs

**Status: RESEARCH_ONLY / UNVERIFIED. Promote: NO.** No live strategy, risk, capital or GitOps change is authorized by
this pack. The JSON/CSV outputs are retained unchanged for historical provenance, including their original labels.

The pack reports **11,520 configurations** searched on the same **191 sessions**. Both chronological halves influenced
selection. `train`, `test`, `dual`, positive quartiles and leave-one-symbol-out checks are therefore search diagnostics,
**not out-of-sample evidence**. The earlier “dual OOS” description was incorrect.

The recorded generator and corpus are absent from this checkout and unavailable at their original temporary paths.
These results cannot be reproduced or independently verified from this pack. They are **not economic validation** or
evidence that this candidate is compatible with the native Bayn mandate. A source-file review is not live-runtime or
account-authority verification.

## Reported historical corpus and assumptions

- Bars: `/tmp/bayn-research/v3/alpaca_iex_2026.tsv`, reported as 191 RTH sessions, 2026-01-02 through 2026-10-06, Alpaca IEX 1m
- Generator: `/tmp/bayn-research/v5/screen_stop_compat.py`
- Cost stress: 5 / 10 / 15 bp round trip
- Notional: $20k ($100k×20%)

Those paths record provenance claims, not available reproducibility inputs. Feed identity, calendar correctness,
session completeness, entry timing, fills and cost assumptions have not been independently verified here.

## Selected hard50/bounce1 cell (historical, unverified)

The retained cell `c80_t60_a30_h90_bounce1_hard50` reports crash ≤−80 bp, VWAP distance ≤−60 bp, age ≥30 minutes,
bounce confirmation after one minute, hold 90 minutes and a hard 50 bp stop. The original generator is unavailable, so
its actual entry timing and session-VWAP construction cannot be established from the summary labels alone.

| Reported metric                                      | Historical value                       |
| ---------------------------------------------------- | -------------------------------------- |
| Trades / trades per session                          | 223 / 1.17                             |
| PnL at 10 bp                                         | +$10,693                               |
| Mean net / hit rate                                  | +24.0 bp / 26.5%                       |
| First / second chronological half (`train` / `test`) | +14.0 / +36.4 bp                       |
| q1–q4                                                | +20.5 / +6.2 / +38.6 / +29.8 bp        |
| Stop fraction / mean hold                            | 72.6% / 37.1 minutes                   |
| Maximum drawdown                                     | −$2,263                                |
| At 15 bp                                             | +$8,463; both searched halves positive |

The artifacts also report about +$6.1k from CRDO, +$2.5k from SNDK, +$1.7k from MRVL, +$0.9k from AMD and −$1.4k from
LITE. Dropping CRDO reportedly leaves +$6.3k with positive halves, while dropping CRDO and SNDK makes the first half
negative. Mega-only / `skip_high_vol` reports roughly six trades. These suggest concentration in the selected sample;
they do not establish a durable semiconductor/high-beta edge or disprove alternatives on an untouched sample.

## Native mandate conflict and other reported variants

[Native Jev source](../../../../services/bayn/src/jev/protocol.ts) selects a **15-minute maximum hold**, and its schema
allows at most **60 minutes**. This candidate's **90-minute hold** is incompatible with both. Native use would require
an explicit protocol/schema and mandate change with applicable qualification and capital approvals. Matching the
50 bp stop alone does not make it mandate-compatible, and no such change is made by this research.

The pack also reports delayed-arm stop50 cells near +$22k, soft50 cells near +$10.8k, wider hard stops and no-stop
variants. These remain unverified selected-search results. Delayed arming removes initial protection; soft, wider and
absent stops each change the stop mandate. The historical v4 no-stop comparison is not a reproducibility claim or a
recommended fallback. Full-session-quantile filtering remains invalid for a causal intraday signal.

## Preserved files

- `ranked_v5.csv`: retained 11,520-configuration grid
- `summary_v5.json`: selected cells and original conclusions
- `validate_winner.json`: reported cost stress and reason breakdown
- `loo_symbol.json`: reported leave-one-symbol-out diagnostics

Names such as `validate_winner` and original “winner”/“dual” labels are historical artifact names. Retention does not
validate their economics or endorse their conclusions. No result JSON/CSV has been corrected to imply a rerun.

## Corrected offline version-2 contract

The [candidate document](../../research-candidate-crash-vwap-bounce-v1.md) defines the corrected offline experiment:

- Declared provider/feed (`alpaca`/`iex`), dataset identity, calendar source and a 13:00 or 16:00 ET session close
- A nonempty unique declared universe and inclusive completed-bar watermark; outside-universe symbols and bars after
  that watermark fail validation
- UTC minute-start timestamps consistent with each bar's New York session date/minute and declared RTH bounds
- Complete contiguous one-minute RTH history from 09:30 through the signal for session VWAP; missing prefixes or gaps
  produce `INCOMPLETE_RTH_MINUTE_COVERAGE` exclusions, with no invented bars or premarket/after-hours contamination
- Explicit exclusions for missing universe symbols or minutes through the declared watermark; valid earlier-prefix
  candidates may coexist with later-history exclusions
- A signal strictly before 15:50 ET, or five minutes before an earlier adjusted flatten; flatten is the earlier of
  15:55 ET and declared session close minus five minutes
- Bounce confirmed by the exact `t+1` close, then an entry reference at the exact `t+2` open, never the confirmation close
- Positive volume on the previous, signal, bounce and entry bars used for candidate price references

The command checks structural consistency of supplied declarations, not independent source, feed, calendar or coverage
authenticity. **Every** record remains `UNQUALIFIED_SOURCE_DECLARATION_NOT_INDEPENDENTLY_VERIFIED`. A complete supplied
minute sequence does not remove that qualification. Records also carry `acceptanceEligible: false` and
`historicalEvidence: 'UNVERIFIED_GENERATOR_AND_CORPUS_UNAVAILABLE_NO_RERUN'`. This candidate extractor does not simulate
fills or validate PnL.
The next-open price is a research proxy, not a validated executable fill: confirmation data may arrive after the print,
and the command does not verify arrival timing or executable quotes.

The old economics have **not** been verified against version 2. A rerun with retained generator and verified corpus,
followed by an untouched pre-registered prospective experiment, is required before new economic conclusions. Rerunning
the already-searched 191 sessions is still development research, not a substitute for prospective evidence.

## Qualification and promotion gates still unmet

- Retained generator/corpus and verified provenance, calendar, coverage, timing and execution assumptions
- Explicit resolution of the 90-minute native protocol/schema and mandate conflict
- Untouched pre-registered ≥20-session evaluation with paired control and no mid-window retuning
- Full acceptance-v2 costs, uncertainty, execution stress, spread, activity and risk requirements
- A protocol decision on concentration/universe and separate promotion/capital authorization

This pack makes no recommendation to promote or alter `strategy.ts`, GitOps, stop policy, risk limits or allocation.
[Current service guidance](../../../../services/bayn/README.md) and
[documentation authority](../../../documentation-authority.md) take precedence over this historical research.

## Offline shadow mode only

Entry point: `services/bayn/src/hybrid-crash-vwap-shadow-command.ts`; pure extractor:
`services/bayn/src/jev/hybrid-crash-vwap-gate.ts`. Input is `bayn.hybrid-crash-vwap.session-bars.v2`; output is
`bayn.hybrid-crash-vwap.shadow.v2`, model `crash-vwap-bounce-2.0.0`.

`BAYN_HYBRID_CRASH_VWAP=off|shadow` defaults to `off`. **`on` is rejected at startup**, not coerced to shadow. The offline
command only reads an input file and creates a new unqualified candidate/exclusion record; it has no live fill, broker,
ledger or strategy effects and is not wired into the Bayn image or GitOps schedule. Deterministic fixed-clock record
replay is a software property, not reproduction of the historical economic search.

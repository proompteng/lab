# RESEARCH candidate: crash∩VWAP + bounce confirm

**Status:** `RESEARCH_ONLY`, unqualified and not promoted. This change does not alter live strategy, risk, capital
authority, broker behavior or GitOps.

**Candidate lineage:** `bayn.research-candidate.crash-vwap-bounce.v1`. The corrected offline input and output contracts
are version 2, with model `crash-vwap-bounce-2.0.0`; historical results below are not evidence for this corrected contract.

## Intent and evidence limits

This is an offline candidate-extraction experiment. It does not execute trades or simulate fills, stops, holding-period
exits, costs or portfolio returns. It does not connect candidates to Jev or another decision layer.

The retained [v5 evidence pack](evidence/2026-10-07-hybrid-hf-v5/README.md) reports a search over **11,520 configurations**
on the same **191-session IEX corpus**. Both chronological halves were used to select candidates. Its `train`, `test`
and `dual` fields are search diagnostics, **not out-of-sample evidence**. Positive halves, quartiles and cost stress do
not remove selection bias.

The original generator and input corpus are absent from this checkout and their recorded temporary paths are
unavailable. The JSON/CSV outputs remain unchanged as **historical, unverified search reports**. They are not a
reproducible experiment or economic validation. Their timing, RTH coverage and VWAP behavior have not been verified
against the corrected version-2 contract and must be rerun with retained inputs and generator code before any new
economic claim. Even that rerun cannot turn the already-searched sessions into an untouched evaluation.

## Corrected offline signal contract (version 2)

| Field                              | Value                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Family                             | `crash_vwap_bounce`                                                                        |
| Crash                              | Exact 1-minute close-to-close return ≤ **−80 bp**                                          |
| VWAP distance                      | `(close / session_vwap − 1) × 1e4 ≤ −60`                                                   |
| Session VWAP                       | Cumulative typical-price × volume / cumulative volume, from RTH open through signal        |
| Required history                   | Every RTH minute from **09:30 ET** through the signal; no missing prefix or gaps           |
| Session age                        | ≥ **30** minutes after RTH open                                                            |
| Signal cutoff                      | Strictly before **15:50 ET**, or five minutes before the earlier calendar-adjusted flatten |
| Bounce confirm                     | Signal at `t`; require the exact `t+1` bar's close to exceed the signal close              |
| Entry reference                    | Exact **`t+2` bar's open**, after the bounce close is known; never the confirmation close  |
| Research max hold                  | **90** minutes; a research parameter, not an authorized native holding limit               |
| Research stop                      | **Hard −50 bp**; matching this stop alone does not satisfy the native mandate              |
| Research flatten                   | Earlier of **15:55 ET** and declared session close minus five minutes                      |
| Historical sizing/cost assumptions | $20k notional on $100k; 10 bp round-trip cost, with 5/15 bp stress reports                 |

On a declared 13:00 ET close, flatten is 12:55 and the signal cutoff is 12:50. The offline extractor records research
parameters and entry references only; the historical sizing, stop, hold and flatten assumptions do not enforce an
execution envelope or imply that a reference price is executable. The next-open reference is a bar-price research
proxy: confirmation data can arrive after that opening print. Arrival timing, quotes and executable fills are not
validated by this command.

## Input provenance and qualification

Input schema `bayn.hybrid-crash-vwap.session-bars.v2` requires a session date, declared `alpaca` provider and `iex` feed,
nonempty dataset and calendar-source identifiers, a nonempty unique `source.universe`, and a declared session close of
13:00 or 16:00 ET. `source.completedThroughMinuteOfDay` declares the inclusive bar-start watermark. Each bar has a UTC
minute-start timestamp matching its America/New_York session date and minute-of-day, with no fractional-minute offset.
Bars must match their symbol key, remain strictly ascending inside the declared RTH bounds and watermark, have positive
consistent OHLC values, and have non-negative volume. Symbols outside the declared universe or bars after the watermark
fail validation. Premarket and after-hours bars cannot enter session VWAP. The previous, signal, bounce and entry bars
must each have positive volume to supply candidate price references.

These are structural checks of caller-supplied declarations. The command does **not** independently verify the feed,
dataset, calendar or source coverage. Every record carries qualification
`UNQUALIFIED_SOURCE_DECLARATION_NOT_INDEPENDENTLY_VERIFIED`, including records whose supplied bars are contiguous.
Missing universe symbols or minutes from 09:30 through the declared watermark yield an explicit
`INCOMPLETE_RTH_MINUTE_COVERAGE` exclusion. A missing prefix or gap before a signal prevents that candidate; a valid
earlier-prefix candidate can coexist with an exclusion for later missing history. Sparse IEX history stays unqualified;
the command never fills gaps with invented bars or relabels partial history as full-session VWAP. Crash, bounce and
next-open entry must also have exact minute continuity. Records explicitly carry `acceptanceEligible: false` and
`historicalEvidence: 'UNVERIFIED_GENERATOR_AND_CORPUS_UNAVAILABLE_NO_RERUN'`.

## Native protocol and mandate incompatibility

The selected source strategy remains `jev` in [strategy.ts](../../services/bayn/src/strategy.ts).
[The native Jev protocol](../../services/bayn/src/jev/protocol.ts) selects **15 minutes** for maximum holding time and
its schema caps that field at **60 minutes**. The research **90-minute** hold exceeds both. Using it in native execution
would require an explicit protocol/schema and mandate change, plus the applicable qualification and capital approvals.
The matching 50 bp stop does not make this candidate mandate-compatible. No such change or approval is made here.

Delayed stop arming, partial/soft stops, wider stops and no-stop variants are separate historical hypotheses with
additional risk-policy conflicts. Their reported search PnL does not justify adopting them.

These statements are source-read limits, not a live-runtime or account-mandate audit. Source selection grants no
capital authority; see the [service README](../../services/bayn/README.md) and
[documentation authority policy](../documentation-authority.md).

## Historical search summary (unverified)

The preserved v5 files report, for their selected hard50/bounce1 cell:

- PnL ≈ **+$10.7k** on $100k×20% at 10 bp; chronological-half means ≈ +14 / +36 bp; all four quartiles positive
- Trades/session ≈ 1.17; hit rate ≈ 26.5%; stop fraction ≈ 73%; maximum drawdown ≈ −$2.3k
- Concentration in CRDO/SNDK/MRVL; dropping CRDO alone reportedly remains dual-positive, dropping CRDO+SNDK does not

These are retained claims, not verified returns, OOS validation or proof of a tradable semiconductor/high-beta edge.

## Offline shadow command

Entry point: [hybrid-crash-vwap-shadow-command.ts](../../services/bayn/src/hybrid-crash-vwap-shadow-command.ts), built by
`bun run build` as `dist/hybrid-crash-vwap-shadow-command.js` (script `hybrid:crash-vwap-shadow`). It is not packaged into
the Bayn image or scheduled by GitOps. It reads one session of bars and writes a new record file, refusing to overwrite.
It has no broker, ledger, model-inference or live-strategy side effects.

```sh
BAYN_HYBRID_CRASH_VWAP=shadow node dist/hybrid-crash-vwap-shadow-command.js \
  --input session-bars.json --input-sha256 <sha256-of-input> --output shadow-record.json
```

`BAYN_HYBRID_CRASH_VWAP` is decoded once at startup through Effect `Config`:

| Value                            | Behavior                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `off` (default, including unset) | No-op; prints `{"mode":"off","outputPath":null}` and writes nothing                           |
| `shadow`                         | Writes an unqualified `bayn.hybrid-crash-vwap.shadow.v2` candidate/exclusion record; no fills |

Every other value, including **`on`**, fails startup. It is not coerced to `shadow`. There is no live enablement in this
contract. `evaluatedAt` comes from the Effect `Clock`; identical validated input and a fixed clock allow deterministic
record/hash replay. That software property does not reproduce or validate the absent historical economic experiment.

## Requirements before any promotion proposal

1. Retain and verify the generator, corpus identity and provenance, calendar, data coverage and execution assumptions;
   rerun historical diagnostics against version 2, preserving failures and exclusions.
2. Resolve the 90-minute hold's native protocol/schema and mandate conflicts explicitly; do not silently change risk.
3. Pre-register the candidate, universe, costs, entry timing, paired control and exclusions before an untouched
   prospective window of at least 20 sessions. Do not retune using that evaluation window.
4. Evaluate the full existing acceptance-v2 requirements, including uncertainty, concentration, execution stress,
   spread gates, costs and risk limits; a positive search cell or a 20-session count alone is insufficient.
5. Seek separate promotion and capital authorization only if all applicable gates are met.

This correction permits offline research only. It makes no recommendation to promote or change the live strategy,
holding limit, stop policy, risk envelope or capital allocation.

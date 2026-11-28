# Bayn profitability master playbook

**Decision:** Qualify the Pure-ETF QQQ+SMH 1.4× Noise Area book on Alpaca **PAPER**. Keep F4 as the primary
overnight comparison, F2 as the higher-turnover comparator, and O1 as a separate shadow canary. Keep consolidated
SIP independent of the active IEX strategy. Neither a replay win, a healthy deployment, nor a scorecard
`PASS` grants broker or live capital authority.

## Wave 1–9 evidence: what survived

The table cites merged evidence, not forecasts. Costs are round trip unless the source says per side.
Do not compare dollar P&L across different sizing or carry conventions as if they were the same backtest.

| Candidate / decision                                        | What the merged evidence shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retain QQQ+SMH Noise Area for PAPER.**                    | [Blind Wave 5A](evidence/2026-11-27-8yr-unseen-intraday-oos/README.md) ([#16377](https://github.com/proompteng/lab/pull/16377)): the **1.2×** C5 predecessor earned $41,848.66 at 2 bp and $17,311.01 at 5 bp on the unseen 2016–2023 tape; at 5 bp it was −$4,371.21 without its ten best days, and it lost $23,585.08 at 10 bp. **1.4× B0** is the separate matched [Wave 6A](evidence/2026-11-27-10yr-16etf-noise-area/README.md) ([#16387](https://github.com/proompteng/lab/pull/16387)) rule: $31,628.26 Holdout and $69,780.16 across 2,741 sessions (~10.9 years) at 5 bp, reproduced in [Wave 9B](evidence/2026-11-27-10yr-qqq-smh-conditioning/README.md) ([#16393](https://github.com/proompteng/lab/pull/16393)). Its full-period break-even is **11.20 bp RT**, not a cost budget; a held-bar gap still vetoed full-path research qualification. The [standalone implementation](etf-noise-area-activation.md) ([#16385](https://github.com/proompteng/lab/pull/16385)) did not activate the strategy.                          |
| **Keep QQQ+SMH+XLK as a post-SIP research candidate only.** | [Wave 9B's separate XLK diagnostic](evidence/2026-11-27-10yr-qqq-smh-conditioning/README.md#separate-diagnostic-add-xlk-with-no-retuning) ([#16393](https://github.com/proompteng/lab/pull/16393)): $73,104 vs $69,780 full-period net and $33,599 vs $31,628 Holdout at 5 bp. Holdout Sharpe rose from 1.167 to 1.224, but drawdown rose from $6,592 to $6,972 and Train net fell. This was not a confirmatory test. Require shadow data proof and a separate preregistered evaluation; do not add XLK to v3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **F4 first; retain F2 as a comparison.**                    | [Wave 5C](evidence/2026-11-27-10yr-vol-regime-carry/README.md) ([#16379](https://github.com/proompteng/lab/pull/16379)): F2 had the largest excess over SHY of the four frozen representatives, but its 10 bp Holdout one-way turnover was **2.20×/yr**, not <0.9×. F4 stayed below **0.91×/yr** in each Wave 5C split; in the later [dual-horizon ledger](evidence/2026-11-27-macro-etf-core-dual-horizon/README.md) ([#16391](https://github.com/proompteng/lab/pull/16391)) it ran at **0.83×/yr** over the full span and **0.93×/yr** in Train at 10 bp per side. Standalone F2 and F4 beat SHY across all three splits in that later replay. Neither qualified in Wave 5C. Same-symbol holdings blocked thousands of Noise attempts and adding Noise never improved terminal equity over its matched standalone core book. Reserve QQQ and SMH and verify both sleeves' gross; standalone correlations are not additive P&L.                                                                                                            |
| **O1 is a research canary, not a funded winner.**           | The [frozen Wave 5D canary/TSMOM/macro ensemble](evidence/2026-11-27-etf-canary-macro-v2/README.md) ([#16376](https://github.com/proompteng/lab/pull/16376)) was the only base ensemble to clear the strict split test at 2/5/10 bp, but 0/135 qualified and its plateau was 0/8. [Wave 6C](evidence/2026-11-27-10yr-pure-etf-dual-horizon/README.md) ([#16381](https://github.com/proompteng/lab/pull/16381)) tied original O1 to 94.43% net at 2 bp and 2.62×/yr Holdout turnover. M4 (O1 plus half-sized C5 and SHY carry) returned 7.39% CAGR with 20.30% max drawdown; O1/I1 standalone correlation was −0.022. Those are retrospective, not prospective fills or evidence to combine two broker writers. The [module rollout notes](macro-canary-etf-rollout.md) ([#16386](https://github.com/proompteng/lab/pull/16386)) and [next-open runner](../../services/bayn/tools/macro-canary-runner/README.md) ([#16388](https://github.com/proompteng/lab/pull/16388)) describe distinct contracts; the runner uses a 10-point drift band. |

## Wave 1–9 evidence: what not to rearm

| Rejected path                                               | Evidence and operator decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Production v2 single-stock MorningOrb / MiddayReversion** | Retire from new entry when v3 is active; keep incumbent recovery running until flat. [Blind Wave 5A](evidence/2026-11-27-8yr-unseen-intraday-oos/README.md) ([#16377](https://github.com/proompteng/lab/pull/16377)): the C1 control lost $24,805.58 at 5 bp on the blind tape; reversion had negative known closed-leg P&L and missing exit marks, so complete net is unknown. [Wave 1 neutralization](evidence/2026-11-27-midday-beta-neutral/README.md) ([#16352](https://github.com/proompteng/lab/pull/16352)) did not rescue ex-top-five net. The [Black Friday PAPER incident](incidents/2026-11-27-black-friday-googl-unclosed-exit.md) ([#16371](https://github.com/proompteng/lab/pull/16371)) is broker/controller evidence, not modeled P&L. The [v2.1 protection work](intraday-v2-1-execution-upgrade.md) ([#16378](https://github.com/proompteng/lab/pull/16378)) does not restore the single-stock thesis.                                       |
| **46-stock OR5 and broader stock sleeves**                  | All three OR5 variants lost money at every cost on the [blind tape](evidence/2026-11-27-8yr-unseen-intraday-oos/README.md) ([#16377](https://github.com/proompteng/lab/pull/16377)); the 46-name OR5 rows were all negative at 5 bp. The [orthogonal fourth-sleeve study](evidence/2026-11-27-orthogonal-sleeve4/README.md) ([#16354](https://github.com/proompteng/lab/pull/16354)) qualified 0 of 113 multi-year minute variants. [SIP Momentum](evidence/2026-11-27-3yr-sip-62sym-rvol-orb-etf/README.md) ([#16360](https://github.com/proompteng/lab/pull/16360)), [stat-arb](evidence/2026-11-27-3yr-sip-62sym-statarb/README.md) ([#16361](https://github.com/proompteng/lab/pull/16361)), and [pairs/PEAD](evidence/2026-11-27-3yr-sip-pairs-ou-pead/README.md) ([#16363](https://github.com/proompteng/lab/pull/16363)) did not produce a deployable alternative. Wave 3B [#16365](https://github.com/proompteng/lab/pull/16365) is not merged evidence. |
| **B4 16-ETF Noise Area**                                    | [Wave 6A](evidence/2026-11-27-10yr-16etf-noise-area/README.md) ([#16387](https://github.com/proompteng/lab/pull/16387)): $1,313 at 2 bp, −$8,092 at 5 bp and −$23,768 at 10 bp in the 729-session Holdout. The SHY overlay did not rescue the intraday thesis. No roster expansion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Unconditional 24/7 spot crypto**                          | [Alpaca spot 24/7 trial](evidence/2026-11-27-3yr-crypto-24x7-trend/README.md) ([#16364](https://github.com/proompteng/lab/pull/16364)): **0/280** earned a frozen nomination or passed the final gates. No venue or capital change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Daily overnight MOC/MOO churn**                           | [Wave 2A](evidence/2026-11-27-5yr-daily-overnight-alpha/README.md) ([#16358](https://github.com/proompteng/lab/pull/16358)): 0/848 passed development. The lagged MOC→Open residual momentum Train leader had **47.7% mean daily one-way turnover** and **−0.93 Validation Sharpe** at 10 bp; same-close sizing/fills were diagnostic and not executable. Do not substitute a daily auction round trip for low-turnover next-open review. The later [#16394](https://github.com/proompteng/lab/pull/16394) auction comparison is not merged evidence.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **All 26 B0 conditioning filters**                          | All 26 trailed unconditioned B0 in the [Wave 9B Holdout](evidence/2026-11-27-10yr-qqq-smh-conditioning/README.md) ([#16393](https://github.com/proompteng/lab/pull/16393)) at both 2 and 5 bp. The frozen RVOL + ATR variant lost $6,520 relative to B0 at 5 bp; DSR 0.9295 was below 0.95. This does not remove required runtime protection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Promote on backtest economics or feed health alone**      | The [allocator study](evidence/2026-11-27-portfolio-allocator/README.md) ([#16357](https://github.com/proompteng/lab/pull/16357)) could match only 3 of 66 live-tape sessions at 2/5 bp after requiring execution evidence. The [clean-factor grid](evidence/2026-11-27-10yr-sp100-clean-factors/README.md) ([#16373](https://github.com/proompteng/lab/pull/16373)) qualified 0 of 85 in development. The [microstructure audit](evidence/2026-11-27-execution-microstructure/README.md) ([#16356](https://github.com/proompteng/lab/pull/16356)) and [three-year SIP audit](evidence/2026-11-27-3yr-sip-bayn21-v2/README.md) ([#16359](https://github.com/proompteng/lab/pull/16359)) motivate checking realized execution, not assuming the cost tier.                                                                                                                                                                                                        |

## Monday, 2026-11-30: gated operator sequence (America/New_York)

These are handoff steps, not actions performed or scheduled by this change. A blocked step blocks its dependents.

1. **09:30 ET or later: let the incumbent PAPER owner settle the GOOGL −103 short.** [#16371](https://github.com/proompteng/lab/pull/16371)
   corrected timed exits and regular half-day close behavior; it did **not** certify a trade at 09:30 or guarantee
   that inventory went flat. Keep close/recovery ownership and stop the cutover if fresh exact reconciliation is
   missing or GOOGL, orders, fills, costs, or claims are unsettled.
2. **Verify flat on that same PAPER account.** Follow the [read-only auditor runbook](live-profitability-audit-runbook.md)
   ([#16392](https://github.com/proompteng/lab/pull/16392)) with its approved SELECT-only standby credentials and the
   verified PAPER account ID. Run
   `bun services/bayn/tools/audit-bayn-live-profitability.ts --session 2026-11-30 --format markdown`.
   Check latest broker and ledger quantities, exact reconciliation after the last mutation, terminal orders and
   intents, accounted fills and costs, and no unresolved claims. Retain the opening carry separately from the latest flat
   cut. An early audit is not a settlement certificate; independently verify the broker/accounting cut.
3. **Only after that proof, merge the reviewed Pure-ETF v3 cutover** [#16395](https://github.com/proompteng/lab/pull/16395).
   Follow its [cutover runbook](https://github.com/proompteng/lab/blob/0f13151752e8c7ffce8e232e6a6fb3caf758c326/docs/bayn/intraday-v3-pure-etf-cutover.md).
   Verify the exact main image against [normal release automation](../release-automation.md), Kargo Freight and generated
   commit, then Argo readback and the v3 QQQ+SMH 1.4× runtime in **OBSERVE**. Do not bypass GitOps.
4. **Activate PAPER in a separate reviewed mandate.** After OBSERVE readback, author a new v3 request bound to the
   deployed image, verified PAPER account and risk policy. Follow the cutover runbook's strict-scoped `kubeseal`
   procedure for the existing secret, preserving the other encrypted values. Verify the reviewed activation through
   the same release path. Confirm effective PAPER, the account/protocol binding, the first natural fill and its
   protection, and the exact close. Do not submit a test order or reuse a v2 or live request.
5. **After the prior close is finalized and before the verified next-open cutoff, run F4 daily in shadow first.**
   [#16397](https://github.com/proompteng/lab/pull/16397) documents the [F2/F4 runner](../../services/bayn/tools/macro-etf-core-runner/README.md).
   Use approved PAPER/SIP read credentials; keep each runner's private artifacts separate.

   ```sh
   bun services/bayn/tools/run-macro-etf-core-rebalance.ts --profile F4 --exclude-symbols QQQ,SMH \
     --output "$EVIDENCE/macro-core/$SESSION.json"
   bun services/bayn/tools/run-macro-canary-etf-rebalance.ts --exclude-symbols QQQ,SMH \
     --output "$EVIDENCE/macro-canary/$SESSION.json"
   ```

   Here `SESSION` is the **execution session**, not the date of signal bars. For the first Monday receipt that means
   a valid plan **before** Monday's open; if the window is missed, do not backfill a pretend Monday plan. Capture
   the next eligible session. Size each planned book inside the combined envelope, using the runners' documented
   budget flag where necessary. Only one overnight runner may own broker mutations for an account; keep O1
   read-only when F4 is being tested. Paper submission requires its own approved account and journal procedure.
   Neither runner's plan receipt proves submission or fills.

6. **Activate the 73-symbol SIP lane as shadow, not as Bayn's execution feed.** Read the three owning contracts:
   [Dorvud SIP forwarder](../../services/dorvud/README.md#consolidated-sip-shadow-forwarder) ([#16384](https://github.com/proompteng/lab/pull/16384)),
   [parallel Flink archive](../../services/dorvud/technical-analysis-flink/README.md#parallel-consolidated-sip-shadow-archive)
   ([#16389](https://github.com/proompteng/lab/pull/16389)), and
   [Bayn roster and provenance](../../services/bayn/src/market-data/sip/universe.ts) ([#16390](https://github.com/proompteng/lab/pull/16390)).
   Use a separate reviewed rollout with the entitled SIP owner and distinct Kafka routes; preserve IEX. When the
   verifier [#16399](https://github.com/proompteng/lab/pull/16399) lands, run
   `bun services/bayn/tools/verify-sip-vs-iex-shadow.ts --session "$SESSION" --format json` against the read-only
   archive and retain the report even when the parity gate fails. Verify five consecutive complete sessions per
   its runbook. The three merged layers do not by themselves deploy the lane or prove coverage. If #16399 is not
   available, report parity as incomplete; matched minute drift from the auditor is only diagnostic.
7. **After every registered PAPER close, publish the qualification scorecard.** Register the first eligible full
   session _after_ activation and settlement; do not count the recovery cut as the first clean day. Collect the
   audit as JSON after post-close exact reconciliation and fee posting, both next-open plans for the same date,
   and the proof described below. Stop and investigate exceptions; don't relabel or omit the affected session.

## Daily scorecard and the promotion boundary

```sh
bun services/bayn/tools/bayn-daily-scorecard.ts \
  --intraday-dir "$EVIDENCE/intraday" --macro-core-dir "$EVIDENCE/macro-core" \
  --macro-canary-dir "$EVIDENCE/macro-canary" --sip-dir "$EVIDENCE/sip" \
  --qualification-file "$EVIDENCE/qualification.json" --format markdown \
  --output "$EVIDENCE/scorecards/$SESSION.md"
```

Each directory contains only its producer's `.json` receipts (one receipt or an array per file). One audit file
can contain multiple sessions; do not supply overlapping cuts or weekend/no-calendar placeholders. Supply SIP
when available; its daily verdict is independent of IEX paper qualification. `--format json` emits canonical
`bayn.multi-horizon-scorecard.v1`; otherwise the default is Markdown (`BAYN_SCORECARD_FORMAT` can override that
default). Omit `--output` for stdout. Output files are private and exclusive. Exit zero means a report was produced;
read `QUALIFICATION_GATE` for the gate. Malformed JSON, invalid schema, duplicate sessions, or digest mismatch
exit nonzero without a new report. A new cut replaces a prior observation in the input set, not a second session.

### Qualification evidence

The audit v1 wire format has no PAPER account/protocol provenance, intraday peak gross, or risk/cost allowance.
Do not infer PAPER/v3 from two symbols, infer peak gross from turnover, or set unknown expenses to zero. Supply a
reviewed `bayn.multi-horizon-qualification-evidence.v1` JSON:

- Top level: `schemaVersion`, `policy` (exactly `bayn.intraday-alpha-policy.v3`), `paperAccountSha256` (approved
  account identity digest), `protocolSha256` (effective v3 protocol), `calendarSourceSha256` (retained
  provider calendar registration), `riskCostPolicySha256` (pre-registered risk/cost policy), `calendar` and
  `proofs`. Use lowercase hex SHA-256. Retain the referenced evidence, not broker credentials or account IDs,
  in the reporting directory.
- Register a prospective, contiguous provider calendar for the campaign. Supply its complete **elapsed prefix**
  through the report cut as `calendar: [{ "date": "YYYY-MM-DD", "openAt": "<UTC>", "closeAt": "<UTC>" }]`;
  include closed sessions with missing receipts, but not holidays or future sessions. Do not choose or drop dates
  after seeing returns. Use the provider's New York regular-session bounds, including early closes and DST.
- Each `proofs` row contains `date`, `auditSessionSha256`, `sourceSha256`, `intradayPeakGrossMicros`,
  `riskCostMicros`, and `stopEvidenceComplete`. `sourceSha256` refers to the retained evidence proving the
  same PAPER identity and v3 protocol for the full session, inventory/marks bounding intraday peak gross, the
  signed-off risk/cost debit, and complete stop-limit observation coverage. Only mark that coverage complete
  when the retained executable-side tape and order evidence can rule out gap-throughs; sparse quotes alone
  cannot. String amounts are integer USD micros. Leave a missing proof absent; never guess a peak or risk debit.
- `auditSessionSha256` is the Bayn canonical SHA-256 of the exact individual audit session object, **not**
  the file hash. Run the scorecard in JSON mode without the qualification file to obtain
  `sessions[].auditSessionSha256`. Use the current auditor so it includes the individual unrounded B0 samples.
  Legacy daily medians cannot be pooled; re-audit retained evidence or leave the window incomplete.
- The CLI checks shape, joins, and content bindings. The original audit and SIP verifier do not sign their output.
  The macro `planSha256` covers their full immutable plan material, including the referenced bar hash, but not
  envelope mode/time, and the full adjusted history is not embedded. Validate the retained source artifacts and
  provenance under the operator's existing review process. A recomputed digest is not proof of authenticity.

### Interpret the result

- **FAIL:** a measured critical anomaly, overlap, gross breach, pooled median above **2.5 bp**, or nonpositive
  cumulative risk-adjusted net after at least 20 registered sessions. Failures take precedence over missing evidence.
- **INCOMPLETE:** fewer than **20 clean PAPER sessions**, missing/stale/unbound evidence, or no measured round trips.
  Negative individual sessions may still be operationally clean. A no-fill day can count only with complete
  evidence; it contributes no slippage samples. The window as a whole must contain measured round trips.
- **PASS:** at least 20 clean registered PAPER sessions, zero critical anomalies across the submitted window,
  measured pooled median **≤2.5 bp**, and strictly positive cumulative risk-adjusted net. The scorecard's gate
  uses the median, not the upstream auditor's stricter single-session mean-and-median gate. Display the pooled
  mean and the **11.20 bp** research breakeven separately. Do not use the research number as a live target.
- Overnight gross is the conservative runner projection for both plans (current positions plus buys, no expected
  sales). Separate accounts add; on a shared account, identical position inventories count once at the larger
  mark and both planned buy increments count. Reject positive _effective_ QQQ/SMH targets or any planned
  QQQ/SMH order: O1's upstream strategic vector precedes exclusions. The ceilings are **$150,000 overnight**
  and **$180,000 overnight plus the proven intraday peak**. This is a projected coexistence bound, not a
  broker's proof of overnight fills or realized intraday mark-to-market for the overnight holdings.
- Net is intraday realized P&L less direct and posted fees. Risk-adjusted net deducts the additional nonnegative
  risk/cost charge from the approved policy, without double-counting booked execution costs. The rolling net is
  over the last 20 registered sessions, not the last 20 profitable or filled days. Missing net is not zero.
  Keep stop-limit gap-throughs, `NO_ADMISSIBLE_CUT`, and EOD strands at zero; escalate any breach under the
  incumbent recovery owner. Never use this CLI to place orders, change mandates, or activate a feed.

A passing report supplies evidence for a **separate** capital decision. It does not supersede Bayn's
[registered economic acceptance and cost policy](jev-migration-validation.md#economic-acceptance), runtime risk
checks, account grants, or the repository's release gates.

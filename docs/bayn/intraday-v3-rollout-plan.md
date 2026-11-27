# Bayn intraday alpha v3 rollout gates

**Status: unqualified, not wired to the controller.** Wave 4F adds only a pure strategy module. No feed,
migration, account authority, order path, or rollout changes with this PR. The existing v2 PAPER policy
and [cutover procedure](intraday-alpha-cutover.md) remain in force.

[Wave 3B](https://github.com/proompteng/lab/pull/16365) is development evidence, not an activation receipt.
Its Train-leading three-engine book used OR5 tilt, noon IQR ≥100 bp with timed exits, and the 1.2× opposite-band
ETF rule. It earned $26,523 at 10 bp across 729 sessions but lost $3,425 in Validation after removing the best
five days, and no combined variant cleared the prespecified Validation gate. Different order collars, absolute exit
times, whole-share noon sizing, and non-atomic broker fills make Wave 4F a different execution contract from that
replay. Neither the [Wave 1E execution audit](https://github.com/proompteng/lab/pull/16356) nor the
[Wave 2B SIP audit](https://github.com/proompteng/lab/pull/16359) proves how this module will fill.

## 1. Produce and qualify the SIP data path

- [ ] Freeze the universe manifest from [policy.ts](../../services/bayn/src/strategy/intraday-alpha-v3/policy.ts):
      **46 equities** for OR5 and noon, **QQQ and SMH** as ETF trade candidates, and **SPY** as a read-only noon
      benchmark (49 subscriptions). Bind the ordered symbols and their hash, dataset version, venue/feed identifiers,
      calendar version, corporate-action convention and source revision. Do not repoint the existing IEX forwarder,
      topics, ClickHouse routes, or v2 strategy; the currently configured IEX, delayed SIP and overnight routes are
      not entitled, real-time Consolidated SIP inputs for v3.
- [ ] In a separate GitOps change, verify Alpaca SIP data entitlement and exact WebSocket subscription acknowledgements
      for status, bars and executable quotes. Use the [Dorvud forwarder](../../services/dorvud/README.md) and its bounded
      provider REST backfill with explicit `sip` feed selection, isolated Kafka topic and reader identity. Preserve
      native 1m bars/updates, feed, revision, first receipt, and Kafka coordinates. Record trading/listing status and its
      effective and receipt times separately. Require active status both at the checkpoint and on receipt. Do not infer an active symbol from today's complete tape or duplicate a
      stream to bypass provider connection limits. No credential or permission changes without separate approval.
- [ ] Extend the [Flink aggregation and archive path](streaming-market-data-design.md) with versioned 5m regular-session
      windows on official Alpaca provider sessions. The calendar must enumerate every exchange session (including
      complete shorter days) and retain `regularOpenAt`/`regularCloseAt` alongside the extended envelope. Aggregate
      the first open, high/low extrema, last close, sum of volume, and volume-weighted SIP VWAP from verified inputs.
      At the 5m boundary compare independent provider 5m versus aggregated 1m prices/volume/VWAP at the chosen
      revision; numerically reconcile in exact decimals, with a documented provider rounding rule. Missing minutes,
      conflicting duplicates, and inability to explain source discrepancies must remain explicit; do not synthesize an
      executable 5m bar or move the original availability timestamp after recovery. Preserve immutable inputs, actual
      publication/consumer receipts and scoped gaps in the archive. Do not change the IEX job's state or output contract.
- [ ] Build a read-only Bayn projection from these streams. Validate schema, full ordered session coverage, feed,
      universe, hashes, completed-window metadata and source watermarks before calling the strategy. Include the last
      14 consecutive complete prior regular sessions (plus the preceding close if present). Pass sessions with
      missing bars as empty/partial rather than skipping the date. Require point-in-time regular-way listing and
      corporate actions; restate prices and volumes into the evaluation date's share units and never apply a future
      split. Keep the current and prior windows causally separate. Feed the strategy at the frozen 5m checkpoint with
      the first usable revision and true local receipt, including the recorded 09:35 opening receipt. Do not replace a
      missed checkpoint with a replayed trade on corrected data. Persist the exact immutable snapshot, policy hash,
      diagnostics, and reconciliation state alongside each decision. Encode integer prices, notionals and shares as
      decimal strings in durable evidence; do not convert strategy BigInts to JSON numbers.
- [ ] Prove actual producer → Flink → archive → Bayn coverage on every symbol/slot across regular and early closes.
      For **2026-11-27** and **2026-12-24** replay the official 09:30–13:00 ET regular calendar inside an extended
      envelope. Show expected/published/available/missing/late/revised slots, unresolved discrepancies and p50/p95/p99
      intake-to-decision lag, including partitions that miss the cutoff. Preserve a separate 1m trade/quote path for
      executable prices, protection verification and latency, never a substitute for admission's 5m SIP evidence.
      A feed, archive or calendar failure denies new entries and never disables reconciled-position reduction.

## 2. Reproduce the strategy and verify blind Wave 4E evidence

- [ ] Freeze the reviewed strategy hash and exact defaults (OR5 tilt, timed noon, 30 bp entries), calendar,
      dataset and adjustment digests, source revision, check definitions and failure thresholds before any blind
      scoring. Equal allocation, bracket mode and any other collar are distinct policy hashes, not post-score fallbacks.
      Register unavoidable replay vs production differences and bind a second, production-contract parity ledger.
- [ ] Verify Wave 4E's **2016–2023 unseen** preregistration and tape digests, frozen development receipts and
      single held-out score on the same equations. Require independently reproduced results, all calendar sessions
      and exclusions, and evidence of no held-out calibration. Keep unsubscribed, unavailable, prelisting, halted,
      corporate-action and unresolved sessions distinct from cash/no signal. Do not use Wave 3B's already inspected
      2024–2026 splits as additional blind evidence.
- [ ] Require the independently reviewed preregistered Wave 4E economic gate to pass before proposing activation.
      Publish Net and Ex-Top-5 at 5 and 10 bp, chronological results, drawdown, coverage, costs, turnover and
      concentration/LOSO, plus native prospective qualification against the registered control as specified by
      [Bayn's acceptance rules](jev-migration-validation.md#economic-acceptance). If Wave 4E's exact freeze cannot be
      verified, a threshold fails, or production deltas are material, keep v2 and stop activation. Do not tune and
      re-score this holdout as blind.

## 3. Prove SHADOW parity without broker mutations

- [ ] Keep v2 as the sole active account owner. Run v3 SHADOW with no broker mutation capability, read-only account
      evidence, and an isolated shadow book. Replay each immutable source cut independently and compare full policy
      hash, eligibility/exclusion reasons, OR5 winner/RVOL/gap/range, noon SPY-relative quartiles and legs, ETF bands
      and exits, share count, reservations and deadline. Require exact decision/serialization parity per observed
      checkpoint given identical input; explain differences from revised historical research data rather than
      backdating them. Compare with v2 as a matched control, not as signal truth.
- [ ] Exercise real regular and early-close clocks, lagged and corrected 5m bars, per-symbol halt/missing/cold-start,
      account restart and reconciliation, stale quotes, missing borrow/locate, competing reservations, duplicate
      submissions, partial/out-of-order fills, and stuck/rejected stops. Verify the full-book admission cap and one
      owner per symbol. Reserve all working and held gross at entry until canonical release. A short sale's limit is a
      minimum, not an upper bound on executed notional: recheck the opening envelope against fresh executable prices
      at submission and reconcile actual gross after price improvement. A breach freezes additional admissions
      while the authorized risk owner reconciles and reduces; the module does not continuously rebalance marks.
- [ ] Prove the order lifecycle in the existing paper-broker acceptance environment before activation. Verify both OCO
      sides, whole-share fills and native stop-limit semantics. At any cancel or deadline, never treat a request or
      lost acknowledgement as terminal: reconcile entry/replacement and protection orders before closing only actual
      residual quantity. Persist the noon abort latch before canceling; reconcile cancel/fill races and unresolved
      reductions before any retry or release. Do not open hedge inventory in another symbol. Demonstrate the wider
      GOOGL buy-to-cover collar at trigger $275.31 with price $275.88, then a gap _beyond_ the new limit; the latter
      still needs bounded protection recovery. Alpaca acknowledgement/readiness is not proof of a fill.
- [ ] Verify deadlines against `regularCloseAt`: OR5 observes 09:35–11:25 ET (the first post-range 5m touch
      can complete at 09:40), then MaxHold is min(11:28, regular close −15m). Noon uses exactly 12:00 ET, with
      either mode flattening by the regular close −5m. Noise observes completed 30m checks from 10:00 through
      min(15:00, regular close −30m); check opposite-band exits even after the entry window. It flattens by the
      regular close −2m. On a 13:00 close the deadlines are 11:28, 12:55 and 12:58, respectively.
      A clock/quote cutoff or missed close is an incident, not authorization to carry overnight. Before PAPER
      enablement, agree on a latency/entry-validity budget with the account owner; enforce the exact original
      timestamp and do not let a late data retry move it.

## 4. Cut over only after reviewed post-close reconciliation

- [ ] Separately review the v3 runtime wiring, account-owned risk checks, durable order/confirmation bindings and any
      new audited SQL admission. Preserve historical v2 contracts and migrations 0222/0223; do not rewrite them.
      Merge through required gates, verify the immutable CI image, eligible Freight, exact `kargo/bayn` revision,
      Argo sync and deployed digest using [release automation](../release-automation.md). Image promotion and
      readiness never grant broker or capital authority.
- [ ] After the provider's **regular** close, pause new v2 entries through the existing account-owner controls.
      Reconcile broker positions and working orders, entry and protection intents, cash, fees, inventory and durable
      ledger; require zero positions/reservations, terminal orders and settled accounting, verified at one fresh
      post-close cut. Preserve observed but unresolved fees/trades as a blocker. Never overlap v2/v3 authority or
      relabel outstanding v2 positions as v3. Bind a new, separately authorized PAPER activation to the exact account,
      reconciled generation, source revision, v3 policy/risk hashes and image.
- [ ] At the next authorized session verify exact active policy, real-time SIP and benchmark receipts, quote/borrow
      and risk controls, per-engine dispositions and the first full post-close reconciliation. A failure disables new
      v3 entries and leaves the active owner responsible for cancel/reduce/reconcile. Only after confirmed flat and
      settled may the owner reactivate the previous reviewed v2 generation using the same authority checks. Do not
      use a code rollback to abandon v3 orders, alter credentials, prune state or bypass Kargo/Argo. Live capital
      activation is outside this plan.

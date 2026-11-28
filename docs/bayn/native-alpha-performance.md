# Native alpha performance evidence

Bayn's private `bayn.forward-performance-report.v9` adds `nativeAlpha` attribution to the existing generation-scoped report. It connects verified intraday-alpha decisions to their selected baskets, broker execution evidence and reconciled completed position episodes. The immutable v4 financial receipt keeps its original schema, hash and terminal-generation persistence rules.

## Read the current generation

Use the exact realized generation from `/v1/status` in the existing reporting or API runtime:

```sh
node dist/forward-performance-command.js \
  --authority-generation <generation-hash> \
  --deadline-ms 30000
```

The command is a read-only analytical cut. Run it outside execution-controller pods, using the existing reporting resource budget. The [service operations guide](../../services/bayn/README.md#operations) describes its deadline, evidence and persistence contracts.

## Decision and financial scope

The decision population is **committed cycle decisions** for the requested account and generation through the captured reconciliation boundary. It includes retained blocked and unfinished cycle decisions. Controller-only abstentions and scheduled opportunities that never produced a cycle decision are outside this population. A recorded decision count therefore measures retained decisions, rather than every market opportunity or every scheduled controller tick.

Strict native decision verification establishes the phase, selected symbols, policy, source observation and funded target. The report preserves their content identities. Bound intent IDs identify the intended execution graph; persisted intents and broker observations provide separate evidence that an order progressed. A plan without financial execution coverage retains that gap. Its absent financial rows cannot supply a zero-fill outcome.

The report keeps qualification and activation build identities under their original meanings. A retained decision does not independently identify its physical executing build, so that field remains unknown. Source and image readiness are separate runtime evidence.

The attributed outcome population is the existing **reconciled completed position episodes**. All fills from entry to flat belong to one episode, including partial fills and protective exits. Attribution requires every inventory-increasing fill in an episode to belong to the same entry decision and immutable engine identity. A protective exit may retain that entry intent ID with the opposite side. Missing or conflicting ownership, inherited positions and unfinished episodes remain explicit. The financial receipt retains its own scope, including gross P&L that cannot be assigned to a complete alpha episode.

`knownCompletedGrossPnlMicros` and the other `knownCompleted*` fields are supported subtotals of attributed closed episodes. They may remain available while another entry is open, unassigned or outside the execution-evidence scope. Basket `completeGrossPnlMicros` and `completeNetAfterDirectFillFeesMicros` require terminally verified entry fills whose entire filled inventory has closed in unambiguous episodes. Engine `complete*` totals additionally require no omitted unverified decision: its unknown phase could belong to that engine. Neither kind of subtotal completes an unfinished generation or session.

## What the basket measurements mean

The report distinguishes selected and funded legs, bound intents, broker-observed orders, filled quantities and completed outcomes. A fully filled basket requires the expected quantities for all selected legs. Partial and one-sided fills remain separate observed structures. A single-leg fallback is its own selected structure, rather than a failed two-sided basket.

`persistedIntentLegCount` and `brokerObservedLegCount` count positive evidence in the captured input. A zero observed count in an `UNKNOWN` or excluded execution scope does not establish that no intent was persisted or no order was submitted. Filled quantities and entry notional remain null when their proof is missing. A `ZERO` fill outcome requires terminal zero-quantity order evidence and complete agreement with the canonical and selected entry transactions. A verified empty alpha decision population is `NO_RECORDED_ALPHA_DECISIONS`, with no engine return inferred from its absence.

Gross and signed entry fill notional use canonical accounting notional at actual entry prices and quantities. Signed entry notional is the signed sum of buy and sell entry fills for the basket. It does not measure marked exposure through the holding period, beta neutrality, margin usage or maximum loss. Those questions require the corresponding time-aligned position, mark and account evidence.

Engine groups retain phase, protocol, behavior and parameter identities. Changing a strategy policy cannot silently combine the new observations with the preceding engine's results. Each basket separately retains its risk-policy identity.

## Costs and conservation

Completed episode gross P&L comes from canonical accounting transactions. Direct fill fees can be deducted where their source is identified. The report separately retains scoped broker fee and operating-cost totals from the existing financial receipt, alongside gross P&L and costs that cannot be assigned to an engine.

Alpaca's retained equity fee activities can identify an account and trading date without identifying an individual engine or position. Those costs stay in the account cost bucket. Exact per-engine broker-net and all-in profit remain unknown until their required allocation evidence exists. A positive gross subtotal, a zero direct fill fee or a reconciled account alone cannot establish fully costed engine profit.

`financialConservation.status: RECONCILED` describes the arithmetic bridge for the captured receipt totals: attributed completed gross plus unattributed gross equals scoped gross, and attributed completed direct fill fees plus unattributed direct fill fees plus unallocated broker costs equals scoped broker execution fees. The unattributed gross residual can include losses. This status does not change `receipt.evidence.status`, prove final fee settlement, fill unknown operating costs or qualify an engine's profitability. Missing receipt totals remain null; `UNDETERMINED` preserves an incomplete bridge. Supported direct-fill fee subtotals can remain available when pooled broker costs are unknown.

Per-engine execution shortfall and benchmark comparison remain `UNDETERMINED` in this section because the forward input does not provide a verified engine allocation of reference prices or matched benchmark evidence. Registered system assessment retains ownership of its separately qualified candidate/control comparison.

The report hash binds this analytical evidence. The stored terminal-generation receipt remains the authority workflow's existing financial contract; appending analytical fields cannot finalize an active mandate or grant capital.

## Use in the next research cohort

The [current v2 strategy guide](intraday-alpha-cutover.md) freezes the implemented rules and records the incomplete historical bar scenario. The [matched-entry cost diagnostic](evidence/2026-11-26-alpha-cost-cohorts/README.md) separates changes in modeled execution price from changes in which trades fill.

Prospective review should retain every scheduled session, its source availability and every incomplete outcome. Compare engines under their original identities, inspect complete, partial and single-leg baskets, and reconcile account costs before making a performance claim. The historical common-entry subset supplies a research hypothesis; actual new PAPER observations supply the prospective evidence. Existing registered system assessment remains the separate path for economic qualification and matched controls.

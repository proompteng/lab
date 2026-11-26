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

The financial population remains the existing **reconciled completed position episodes**. All fills from entry to flat belong to one episode, including partial fills and protective exits. Attribution binds the episode to its entry decision and immutable engine identity. Missing or conflicting ownership, inherited positions and unfinished episodes remain explicit. Supported closed-episode subtotals are useful diagnostics; they do not complete an unfinished generation or session.

## What the basket measurements mean

The report distinguishes selected and funded legs, bound intents, broker-observed orders, filled quantities and completed outcomes. A fully filled basket requires the expected quantities for all selected legs. Partial and one-sided fills remain separate observed structures. A single-leg fallback is its own selected structure, rather than a failed two-sided basket.

Gross and signed entry fill notional describe actual entry prices and quantities. Signed entry notional measures the basket's initial dollar imbalance. It does not measure marked exposure through the holding period, beta neutrality, margin usage or maximum loss. Those questions require the corresponding time-aligned position, mark and account evidence.

Engine groups retain phase, protocol, behavior and parameter identities. Changing a policy cannot silently combine the new observations with the preceding engine's results.

## Costs and conservation

Completed episode gross P&L comes from canonical accounting transactions. Direct fill fees can be deducted where their source is identified. The report separately retains scoped broker fee and operating-cost totals from the existing financial receipt, alongside gross P&L and costs that cannot be assigned to an engine.

Alpaca's retained equity fee activities can identify an account and trading date without identifying an individual engine or position. Those costs stay in the account cost bucket. Exact per-engine broker-net and all-in profit remain unknown until their required allocation evidence exists. A positive gross subtotal, a zero direct fill fee or a reconciled account alone cannot establish fully costed engine profit.

The report hash binds this analytical evidence. The stored terminal-generation receipt remains the authority workflow's existing financial contract; appending analytical fields cannot finalize an active mandate or grant capital.

## Use in the next research cohort

The [current v2 strategy guide](intraday-alpha-cutover.md) freezes the implemented rules and records the incomplete historical bar scenario. The [matched-entry cost diagnostic](evidence/2026-11-26-alpha-cost-cohorts/README.md) separates changes in modeled execution price from changes in which trades fill.

Prospective review should retain every scheduled session, its source availability and every incomplete outcome. Compare engines under their original identities, inspect complete, partial and single-leg baskets, and reconcile account costs before making a performance claim. The historical common-entry subset supplies a research hypothesis; actual new PAPER observations supply the prospective evidence. Existing registered system assessment remains the separate path for economic qualification and matched controls.

# Torghut Trading Engine Glossary and Mechanics (2026-03-29)

## Status

- Date: `2026-03-29`
- Purpose: give a new engineer one grounded glossary for the current Torghut trading engine, replay path, and diagnostics vocabulary
- Scope: `services/torghut/**`, `argocd/applications/torghut/**`, Torghut-local replay/profitability terminology, and the interfaces Torghut uses with Jangar/TA/ClickHouse/Kafka

## Why this document exists

Torghut has accumulated a lot of local vocabulary:

- `SignalEnvelope`
- `StrategyDecision`
- `TradeDecision`
- `sleeve`
- `opening window`
- `continuation breadth`
- `quote invalid ratio`
- `decision_count`
- `filled_count`
- `planned`, `rejected`, `submitted`
- `replay_quote_skipped`

That vocabulary is meaningful, but it is hard to follow if you do not already know the runtime path.

This glossary is meant to answer two questions quickly:

1. what does each term mean in Torghut specifically?
2. where in the code does that term actually become real behavior?

## End-to-end mechanics

This is the shortest accurate flow for one signal through Torghut today.

1. market data arrives from external providers through websocket and related ingestion lanes.
2. Torghut TA logic produces normalized rows such as `ta_signals` and related market-state payloads.
3. replay or live evaluation converts one signal row into a `SignalEnvelope`.
4. `DecisionEngine.observe_signal(...)` enriches the signal with session-context state before strategy evaluation.
5. `DecisionEngine.evaluate(...)` filters to enabled strategies, normalizes a feature vector, and calls `StrategyRuntime`.
6. `StrategyRuntime` runs one or more strategy plugins or research sleeves and may emit one or more `StrategyIntent` or `StrategyDecision` objects.
7. the scheduler and execution layer persist concrete decisions as `TradeDecision` rows, apply governance and execution checks, and may submit orders.
8. replay tracks decisions, fills, costs, and trade outcomes, but does not persist every raw non-decision as a durable row.

The key split is:

- **signal observation** happens for every incoming signal;
- **strategy decisions** happen only when a sleeve emits an executable intent;
- **persisted trade decisions** happen only after Torghut has a concrete decision object to track.

## Core files in the flow

- `services/torghut/app/trading/models.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/quote_quality.py`
- `services/torghut/app/trading/session_context.py`
- `services/torghut/app/trading/decisions.py`
- `services/torghut/app/trading/strategy_runtime.py`
- `services/torghut/app/trading/research_sleeves.py`
- `services/torghut/app/trading/execution.py`
- `services/torghut/app/trading/scheduler/pipeline.py`
- `services/torghut/scripts/local_intraday_tsmom_replay.py`
- `argocd/applications/torghut/strategy-configmap.yaml`

## Glossary

### System and data surfaces

#### Torghut

The trading service itself. Torghut owns:

- signal normalization,
- feature enrichment,
- strategy evaluation,
- replay,
- trade decision persistence,
- execution governance,
- live order submission.

#### Jangar

The upstream control-plane and dependency authority service that Torghut relies on for symbol-universe, readiness, and broader rollout truth. In practice, “Jangar universe” usually means the approved live symbol set Torghut should trade against.

#### TA

Short for technical analysis in the Torghut codebase. This is not just indicator math in the abstract. It is the producer path that turns upstream market data into rows like `ta_signals` with fields such as:

- price,
- EMA,
- MACD,
- RSI,
- VWAP,
- imbalance,
- spread,
- session/opening-window fields.

#### WS

Short for websocket market-data ingestion. When engineers say “inspect WS,” they usually mean the upstream live quote/trade feed that eventually becomes TA rows.

#### ClickHouse

The retained analytics and replay surface Torghut reads from for local profitability proof. In the current workflow, `ta_signals` in ClickHouse is the direct local replay input for most recent intraday proof loops.

#### Kafka

The bounded event-retention bus. In the current profitability program, Kafka is not the preferred immediate replay source for this week if ClickHouse already contains replay-grade TA output. Kafka matters when Torghut needs durable archive/bootstrap recovery outside the retained ClickHouse window.

#### Signal

A single market-state observation at one timestamp for one symbol. In practice, Torghut mostly evaluates second-level TA-derived signals for equities.

#### SignalEnvelope

The normalized trading DTO that carries one signal through the decision engine. Defined in `services/torghut/app/trading/models.py`.

Fields include:

- `event_ts`
- `symbol`
- `payload`
- `timeframe`
- `ingest_ts`
- `seq`
- `source`

If you want to know what Torghut is “looking at” on one timestamp, this is the first real object to inspect.

#### Payload

The raw or enriched key-value map attached to a `SignalEnvelope`. It contains both direct market fields and Torghut-derived fields. Examples:

- `price`
- `spread`
- `vwap_w5m`
- `price_vs_opening_range_high_bps`
- `recent_microprice_bias_bps_avg`
- `cross_section_continuation_rank`

### Feature layer

#### Feature extraction

The process that pulls useful typed values from the signal payload. This lives in `services/torghut/app/trading/features.py`.

Examples:

- `extract_price(...)`
- `extract_macd(...)`
- `extract_rsi(...)`
- `extract_volatility(...)`

#### FeatureVectorV3

The current normalized feature-contract object that strategy runtime consumes. Defined in `services/torghut/app/trading/features.py`.

This is the “clean room” version of the signal payload after Torghut has:

- normalized values,
- enforced schema expectations,
- attached identity fields,
- hashed the normalized content.

#### FeatureNormalizationError

The failure mode when a signal cannot satisfy the required feature contract. If this happens, Torghut returns no decisions for that signal.

#### Executable price

The price Torghut believes could realistically be used for trading, not just any display or derived field. In current code, this is resolved from actual trade keys first and then from imbalance bid/ask midpoint if needed.

This matters because profitability claims become fake if replay or live logic uses non-executable prices.

### Quote and microstructure terms

#### Bid / ask

The best current buy-side and sell-side quote prices. In Torghut’s TA payloads these often appear as imbalance-derived quote fields.

#### Spread

The distance between ask and bid. Wide spreads usually imply worse execution quality and higher slippage risk.

#### Spread bps

Spread expressed in basis points relative to price. Torghut uses both instantaneous spread and recent spread history as gates.

#### Quote quality

The live/replay check that decides whether a quote state is executable enough to trust. Implemented in `services/torghut/app/trading/quote_quality.py`.

Key invalid reasons include:

- `non_positive_price`
- `non_positive_bid`
- `non_positive_ask`
- `crossed_quote`
- `spread_bps_exceeded`
- `wide_spread_midpoint_jump`

#### Crossed quote

A quote where `ask < bid`. This is treated as invalid and should not be traded through.

#### Midpoint jump

A sudden move in the quote midpoint versus the previous valid price. Torghut uses this together with spread width to suppress corrupt or non-executable quote states.

#### Imbalance

In Torghut’s current vocabulary, this usually refers to buy-vs-sell pressure derived from imbalance bid/ask prices and sizes. Relevant payload fields include:

- `imbalance_bid_px`
- `imbalance_ask_px`
- `imbalance_bid_sz`
- `imbalance_ask_sz`
- `imbalance_pressure`

#### Imbalance pressure

A signed measure of directional pressure. Positive values generally imply stronger buy-side pressure; negative values imply weaker or sell-heavy pressure.

#### Microprice bias

A short-horizon directional indicator derived from the quote state. In Torghut, recent microprice bias is used as a confirmation input for continuation-type entries.

#### Quote invalid ratio

The recent fraction of quote observations that were considered invalid. High values are a bad sign for execution quality and often block entries.

### Session and intraday structure terms

#### Session

The current regular U.S. trading day for one symbol.

#### Session open

The anchored opening price for the regular session. Torghut explicitly avoids letting premarket ticks define this anchor.

#### Previous session close

The prior day’s closing anchor. Torghut uses this so “drive” can be measured relative to yesterday’s close, not only today’s open.

#### Opening window

The first bounded period after the regular-session open used to define early-session structure. Torghut tracks:

- `opening_window_close_price`
- `opening_window_return_bps`
- `opening_window_return_from_prev_close_bps`

#### Opening range

The high/low range formed during the opening window.

#### ORH / opening range high

The high of the opening range. Continuation and breakout sleeves often use “above ORH” as a structural confirmation.

#### ORL / opening range low

The low of the opening range. Reversal or rebound sleeves often reference this on downside dislocations.

#### Session range

The full intraday high-low range observed so far in the session.

#### Session range position

The current price position within the day’s session range. Values near `1` mean the symbol is trading near session highs; values near `0` mean it is near session lows.

#### Session open drive

Current price movement relative to the regular-session open, measured in bps.

#### Opening-window hold

Whether price has stayed above the opening-window-close anchor often enough recently to qualify as persistent strength rather than a one-tick spike.

### Cross-sectional terms

#### Cross-sectional rank

A percentile-like ranking of one symbol versus the rest of the active universe for a specific metric on the same day. Session context computes these in `services/torghut/app/trading/session_context.py`.

Examples:

- `cross_section_opening_window_return_rank`
- `cross_section_continuation_rank`
- `cross_section_reversal_rank`

#### Breadth

A universe-level ratio or composite showing how widespread a condition is across symbols, not just how strong one symbol is.

Examples:

- `cross_section_positive_session_open_ratio`
- `cross_section_above_vwap_w5m_ratio`
- `cross_section_continuation_breadth`

#### Continuation rank

A composite rank that measures how strongly a symbol looks like an ongoing intraday winner versus peers.

#### Reversal rank

A composite rank that measures how strongly a symbol looks like an intraday loser or rebound candidate versus peers.

#### Same-day leader

A symbol that is already among the strongest names in the universe on that same trading day. This matters because the breakout sleeve has recently added guarded “leader reclaim” logic for elite single-name continuation even when broad market breadth is weaker.

### Strategy terms

#### Strategy

A catalog row in Torghut’s configured strategy list. The declarative catalog lives in `argocd/applications/torghut/strategy-configmap.yaml`.

A strategy row includes:

- `name`
- `strategy_id`
- `strategy_type`
- `enabled`
- universe symbols
- risk and sizing limits
- param gates

#### Enabled strategy

A strategy with `enabled: true` in the loaded catalog. `DecisionEngine.evaluate(...)` filters out disabled strategies before runtime execution.

This means disabled strategies literally do not participate in decision generation.

#### Sleeve

A strategy module focused on one market behavior. In current Torghut research vocabulary, sleeves include:

- momentum pullback
- breakout continuation
- mean reversion rebound
- late-day continuation
- end-of-day reversal

When engineers say “multi-sleeve,” they mean combining multiple distinct intraday behaviors rather than relying on one universal rule.

#### Strategy runtime

The deterministic plugin execution layer in `services/torghut/app/trading/strategy_runtime.py`. It:

- resolves strategy plugins,
- validates feature requirements,
- executes plugins,
- records runtime observation and errors,
- aggregates non-isolated intents.

#### Strategy plugin

A concrete evaluator for one strategy type, such as:

- `IntradayTsmomPlugin`
- `BreakoutContinuationLongPlugin`
- `LateDayContinuationLongPlugin`

#### Research sleeve

A strategy implementation in `services/torghut/app/trading/research_sleeves.py`. These are research-backed deterministic sleeves used by the runtime.

#### StrategyIntent

The runtime-level directional intent produced by a plugin before the decision engine converts it into an orderable decision.

#### AggregatedIntent

A symbol-level merged intent from multiple non-isolated strategies. If isolated strategies are enabled, those remain separate instead of being merged into one combined symbol intent.

#### StrategyDecision

The executable decision DTO emitted by Torghut after strategy evaluation. Defined in `services/torghut/app/trading/models.py`.

Fields include:

- `strategy_id`
- `symbol`
- `event_ts`
- `action`
- `qty`
- `order_type`
- `limit_price`
- `rationale`
- `params`

This is the first object that looks like a real order candidate.

#### Rationale

A human-readable explanation or compact reason string attached to a decision. Replay logs this so engineers can see why a decision was queued.

### Execution and persistence terms

#### TradeDecision

The persisted database row for a concrete strategy decision. Created in `services/torghut/app/trading/execution.py`.

If Torghut never emitted a `StrategyDecision`, there will be no `TradeDecision` row.

#### Decision hash

The idempotency digest derived from the executable order intent. It is intentionally based on trade-relevant fields, not auxiliary telemetry, so repeated identical decisions do not create duplicate submissions.

#### Planned decision

A `TradeDecision` row with status `planned`. This means Torghut has decided something concrete enough to persist, but not necessarily executed it yet.

#### Rejected decision

A persisted `TradeDecision` that later failed governance or submission checks. Rejections are tracked both as row status and as aggregate metrics.

#### Execution

The persisted submission/execution record associated with a `TradeDecision`.

#### LLMDecisionReview

The persisted advisory/review record for LLM-mediated decision review in the live scheduler path. This is separate from the base `TradeDecision`.

#### /trading/decisions

The live endpoint that returns recent persisted `TradeDecision` rows, not every observed signal and not every filtered-out non-decision.

### Replay and proof terms

#### Local replay

The historical simulation path in `services/torghut/scripts/local_intraday_tsmom_replay.py`. It reads retained ClickHouse TA signals and runs Torghut’s decision logic over them.

#### Replay quote skip

A logged event where replay rejects a quote state as non-executable. Logged as `replay_quote_skipped`.

This matters because a “flat” strategy can be sparse either because:

- the sleeve emitted nothing, or
- quote-quality logic correctly refused to trade through bad quote states.

#### Replay decision queued

The log event that records one replay decision entering the pending/fill path. Logged as `replay_decision_queued`.

#### Replay trade closed

The log event that records a round trip being closed. Logged as `replay_trade_closed`.

#### Decision count

The total number of strategy decisions replay recorded, whether or not every one became a profitable trade.

#### Filled count

The total number of replay order fills.

#### Gross P&L

Profit or loss before transaction costs.

#### Net P&L

Profit or loss after costs. This is the honest profitability number that matters.

#### Cost total

The estimated transaction-cost drag applied by replay.

#### Wins / losses

Counts of profitable or losing closed trades.

### Risk and gating terms

#### Cooldown

A mandatory wait period after certain entries or exits before the same strategy may re-enter. This suppresses churn but also lowers trade count.

#### Max entries per session

How many times a sleeve may enter for a symbol in one trading day.

#### Max concurrent positions

The maximum number of simultaneous open positions for a sleeve.

#### Position isolation mode

Whether inventory and overlays are scoped per strategy or shared more broadly. `per_strategy` means sleeves do not fight over the same symbol inventory as if they were one monolith.

#### Stop loss

The hard downside exit threshold.

#### Trailing stop

An exit that activates after profit and follows the position with a drawdown limit rather than using only a static loss threshold.

#### Signal exit

An exit triggered by the sleeve’s own weakening conditions rather than a stop or forced flatten.

#### Session flatten

A forced exit near the end of the trading day so Torghut does not carry intraday sleeves overnight.

#### Latest entry cutoff

A time gate that blocks new entries too close to the flatten window. This avoids entering a trade that has no time to work.

### Why trade count is currently sparse

These are the practical reasons Torghut often “does nothing” in replay:

1. the checked-in active catalog does not currently enable every candidate sleeve;
2. the enabled sleeves are more selective than the older TSMOM path;
3. breakout and late-day continuation require stacked confirmation, not one indicator crossover;
4. quote-quality gates reject many wide-spread or invalid quote states;
5. cooldowns, max-entry caps, and latest-entry cutoffs intentionally suppress churn.

If a week looks flat, do not assume one cause. The correct diagnosis order is:

1. check whether the sleeve is enabled in `strategy-configmap.yaml`;
2. check whether the sleeve emitted any `StrategyDecision`;
3. check replay logs for `replay_quote_skipped`;
4. check whether positions were blocked by cooldown, lockout, or timing gates;
5. check whether trades existed but were rejected or never filled.

### What Torghut saves today

Torghut **does save**:

- concrete `TradeDecision` rows,
- execution records tied to those decisions,
- LLM review records,
- decision rejection totals and decision-state metrics,
- replay day-level summaries, largest wins/losses, and key logs.

Torghut **does not save**:

- a durable structured row for every raw signal that produced no decision,
- a full per-timestamp reason ledger for every gating failure in local replay.

That distinction matters. “No persisted decision” can mean:

- the strategy was disabled,
- the strategy emitted nothing,
- feature normalization failed,
- quote quality blocked the path before execution,
- or the signal was observed but never became an executable decision.

## Recommended onboarding order

For a new engineer trying to understand current mechanics, read in this order:

1. `services/torghut/app/trading/models.py`
2. `services/torghut/app/trading/features.py`
3. `services/torghut/app/trading/quote_quality.py`
4. `services/torghut/app/trading/session_context.py`
5. `services/torghut/app/trading/decisions.py`
6. `services/torghut/app/trading/strategy_runtime.py`
7. `services/torghut/app/trading/research_sleeves.py`
8. `services/torghut/app/trading/execution.py`
9. `services/torghut/app/trading/scheduler/pipeline.py`
10. `services/torghut/scripts/local_intraday_tsmom_replay.py`
11. `argocd/applications/torghut/strategy-configmap.yaml`

## Current operational warning

Do not confuse these three things:

- the checked-in live strategy catalog,
- a temporary local replay config used for experimentation,
- a profitable research sleeve that is not currently enabled in the active catalog.

Those are different states, and mixing them is one of the fastest ways to produce fake conclusions about profitability.

# 37. Options Trading Runtime, Execution, and Risk Integration (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `implementation-ready design`
- Scope: `services/torghut/app/trading/**`, `services/torghut/scripts/**`,
  options broker integration, Torghut Postgres execution/accounting state, and the
  operating contracts that would eventually allow options decisions to become orders
- Depends on:
  `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`,
  `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`,
  `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`, and
  `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
- Primary objective: define the safe runtime boundary for bringing options-derived
  signals into Torghut trading, including order construction, pricing, portfolio
  sizing, exercise/assignment handling, and promotion gates
- Non-goals: immediate live options execution, uncovered short options, or a broad
  "all asset classes everywhere" refactor

## Executive Summary

The current Torghut trading runtime is still equity-shaped. Prices are read from
`ta_microbars`; the dataset compiler recognizes `torghut:equity:enabled`; execution
policy normalizes to common US-equity tick sizes; risk and portfolio controls are
framed around `equity`, `buying_power`, and `max_position_pct_equity`.

That is not a criticism. It is simply the proof that documents 33 through 36 were the
right first moves: build data truth and replay proof before pretending the existing
runtime can safely carry options orders.

This document defines the next boundary:

- options trading is a lane-specific runtime integration, not a casual extension of
  equity `ta_signals`;
- initial execution scope is intentionally narrow: long premium and position-closing
  flows only;
- risk authority becomes contract-aware, multiplier-aware, and expiry-aware;
- Alpaca option activities, exercise instructions, and DNE behavior are explicit
  operating contracts, not afterthoughts.

## Context

Live options trading adds a second layer of complexity beyond market data:

- order payloads differ from equities even when the broker reuses the same order API;
- early exercise and expiration create non-trade lifecycle events;
- buying power, premium-at-risk, and assignment risk are not captured by equity-only
  sizing logic;
- one contract symbol represents leverage on an underlying security rather than the
  underlying security itself.

Alpaca's current options trading docs also make the operating constraints explicit:

- options orders use the Trading API order endpoint with options-specific
  validations;
- options positions reuse the Positions API shape;
- exercise has an API endpoint;
- DNE has an API endpoint in current docs;
- assignment activity is not delivered via websocket and must be polled from REST /
  account activities.

These behaviors have to be first-class in the Torghut design, not hidden inside a
generic execution adapter.

## Verified Current State

### Execution price normalization is explicitly US-equity-oriented

[`services/torghut/app/trading/execution_policy.py`](services/torghut/app/trading/execution_policy.py)
documents `_normalize_price_for_trading(...)` as aligning broker-facing prices to
"common US-equity tick sizes" and quantizes prices to:

- `0.0001` below `$1`
- `0.01` otherwise

That is not a safe universal rule for options orders.

### Market-price lookup still reads the equity microbar table

[`services/torghut/app/trading/prices.py`](services/torghut/app/trading/prices.py)
queries `ta_microbars` and returns `source="ta_microbars"` in the market snapshot.

There is no options-aware pricing adapter that reads
`options_contract_bars_1s` or an options quote surface.

### Dataset selection still only recognizes an equity universe contract

[`services/torghut/app/trading/llm/dspy_compile/dataset.py`](services/torghut/app/trading/llm/dspy_compile/dataset.py)
supports `torghut:equity:enabled`, but no options universe selector. That proves the
current research and dataset tooling cannot yet train or evaluate strategy logic on an
options contract universe.

### Risk and portfolio controls are equity-centric

[`services/torghut/app/trading/risk.py`](services/torghut/app/trading/risk.py)
enforces position growth against `equity * max_pct`.

Repository search across `services/torghut/app/trading/**` shows the broader runtime
is still anchored to:

- `max_position_pct_equity`
- `buying_power`
- `ta_signals`
- `ta_microbars`

There is no existing concept of:

- contract multiplier,
- max premium at risk,
- defined-risk spread width,
- expiry concentration,
- assignment exposure.

## Design Decision

### Decision 1: options trading is a dedicated runtime lane

The first live options trading implementation is not allowed to "just read from the
options tables" while remaining otherwise equity-shaped. It gets explicit lane-aware
pricing, risk, portfolio, and execution surfaces.

### Decision 2: initial live scope is long premium and close-outs only

The first live options execution scope is deliberately narrow:

- buy-to-open single-leg long calls and puts
- sell-to-close of held long positions
- broker-driven exercise/DNE instruction handling for held longs

The following are explicitly excluded from the first live phase:

- naked short calls
- naked short puts
- uncovered assignment exposure
- multi-leg spread execution
- automatic exercise of new short positions

This is the smallest scope that can still produce real trading value without forcing
assignment and margin complexity into the first live cut.

### Decision 3: promotion requires replay proof from document 36

No options strategy, rule model, or LLM-controlled decision path can reach live order
submission until it has attached replay evidence from the options proof lane.

### Decision 4: lifecycle events are risk events, not bookkeeping

Exercise, DNE, assignment, and expiry affect both risk and state truth. Torghut must
poll and persist these events rather than assuming websocket order updates are
sufficient.

## Selected Architecture

### Runtime components

The options trading wave introduces five runtime components:

| Component | Responsibility |
| --- | --- |
| `OptionsSignalAdapter` | Read options-derived features and convert them into trading-runtime signal objects |
| `OptionsPriceService` | Resolve executable prices from options quotes, contract bars, and broker confirmations |
| `OptionsRiskPolicy` | Enforce premium, concentration, DTE, liquidity, and lifecycle limits |
| `OptionsExecutionAdapter` | Build and submit broker order payloads and reconcile order activities |
| `OptionsLifecycleMonitor` | Poll positions and activities for exercise, DNE, assignment, and expiry transitions |

These may live inside the existing `services/torghut/app/trading/**` package tree,
but they are lane-specific interfaces, not anonymous conditionals scattered through
the equity runtime.

### Runtime flow

1. `OptionsSignalAdapter` reads `options_contract_features` and
   `options_surface_features`.
2. It emits a lane-aware signal that carries:
   - contract symbol
   - underlying symbol
   - option type
   - strike
   - expiry
   - DTE
   - mid/mark context
   - liquidity / spread quality
3. `OptionsRiskPolicy` decides whether the signal is tradable.
4. `OptionsExecutionAdapter` constructs an Alpaca-compatible order request.
5. `OptionsLifecycleMonitor` keeps the resulting position state truthful through
   order fills, exercise instructions, DNE actions, assignments, and expiry.

### Data model contract

The runtime uses two distinct symbol concepts:

- `underlying_symbol`: the equity symbol such as `AAPL`
- `contract_symbol`: the option contract such as `AAPL250321C00200000`

Every options trading decision must carry both. No downstream layer may attempt to
reconstruct one from the other.

### Broker integration contract

Based on Alpaca's current official docs:

- options orders use the standard order endpoint with options-specific validation
  rules;
- option positions use the Positions API;
- exercise instructions are submitted through the exercise endpoint;
- DNE instructions exist and must be modeled explicitly;
- options-specific non-trade activities and assignment visibility come from account
  activity polling rather than websocket updates.

This means `OptionsExecutionAdapter` is only half the story. `OptionsLifecycleMonitor`
is equally mandatory because broker truth extends beyond orders and fills.

## Interfaces and Data Contracts

### Runtime input tables

The first live options trading runtime reads from:

- `options_contract_features`
- `options_surface_features`

It does not read from equity `ta_signals` or `ta_microbars`.

### Runtime decision contract

The options decision object must carry at minimum:

| Field | Type | Notes |
| --- | --- | --- |
| `lane` | `string` | fixed to `options` |
| `contract_symbol` | `string` | broker order symbol |
| `underlying_symbol` | `string` | underlying equity |
| `action` | `string` | `buy_to_open`, `sell_to_close`, `exercise`, `dne` |
| `qty_contracts` | `decimal` | contract count |
| `limit_price` | `decimal` | contract premium price |
| `option_type` | `string` | `call` or `put` |
| `strike_price` | `decimal` | strike |
| `expiration_date` | `date` | expiry date |
| `dte` | `int` | days to expiry |
| `mid_price` | `decimal` | observed mid |
| `mark_price` | `decimal` | observed mark if present |
| `spread_bps` | `decimal` | liquidity quality input |
| `premium_notional` | `decimal` | `qty * price * multiplier` |
| `rationale_json` | `jsonb` | strategy / LLM rationale payload |

### Runtime risk policy contract

`OptionsRiskPolicy` must enforce all of the following before order submission:

- maximum premium-at-risk per contract and per underlying
- maximum portfolio premium-at-risk
- minimum liquidity thresholds
- maximum spread thresholds
- minimum DTE and maximum DTE bands
- expiry-day restrictions
- concentration caps by underlying and expiry bucket
- explicit blocking of unsupported strategies

### Runtime state tables

The options execution wave introduces four Torghut-owned Postgres tables:

- `public.torghut_options_trade_decisions`
- `public.torghut_options_orders`
- `public.torghut_options_positions`
- `public.torghut_options_lifecycle_events`

`torghut_options_lifecycle_events` must persist:

- exercise instructions
- DNE instructions
- assignment activities
- expiry events
- broker sell-out events related to exercise risk

### Promotion gate contract

An options strategy can only move from paper or simulation to live when all of the
following exist:

- document 35 hardening gates have passed on `opra`
- document 36 replay proof artifacts exist for the strategy
- runtime risk policy is enabled in enforce mode
- lifecycle polling and reconciliation are active

## Failure Modes and Ops

### Wrong tick-size normalization

If options orders reuse equity price normalization blindly, Torghut may produce broker
rejects or deterministic price drift. Options pricing must be normalized by broker
rules for options, not by the current equity helper.

### Lifecycle truth gaps

If Torghut only listens for order updates and ignores activity polling, assignment,
exercise, or expiry state can desynchronize positions and capital usage.

### Hidden short-risk expansion

Any future spread or short-option support must be a separate design wave. The first
live options phase must not quietly drift from long premium into assignment-bearing
short exposure.

### Cross-lane contamination

Equity and options runtime state must remain isolated enough that:

- option positions do not overwrite equity positions,
- options decisions do not pollute equity datasets,
- equity pricing code does not price options orders.

## Rollout Phases

### Phase 1: lane-aware runtime primitives

- add options signal, price, risk, and execution interfaces
- add options lifecycle polling and state persistence
- keep execution in paper/simulation only

### Phase 2: paper options trading

- run strategy decisions through the full runtime
- submit paper broker orders only
- exercise DNE and lifecycle monitoring on paper accounts

### Phase 3: narrow live promotion

- enable live long-premium entries and close-outs only
- keep short options and spreads disabled
- require operator approval for the first live sessions

## Acceptance Criteria

This document is complete only when all of the following are true:

- Options runtime reads options-derived tables, not equity tables.
- Options decisions carry both `contract_symbol` and `underlying_symbol`.
- Risk enforcement covers premium-at-risk, DTE, spread quality, and concentration.
- Lifecycle monitoring persists exercise, DNE, assignment, and expiry events.
- Paper trading passes before live is enabled.
- The first live phase supports only long-premium entries and close-outs.

## External References

- [Options Trading](https://docs.alpaca.markets/docs/options-trading)
- [Create an Order](https://docs.alpaca.markets/v1.3/reference/orders)
- [Exercise an Options Position](https://docs.alpaca.markets/v1.3/reference/optionexercise)
- [Do Not Exercise an Options Position](https://docs.alpaca.markets/v1.3/reference/optiondonotexercise)
- [Non-Trade Activities for Option Events](https://docs.alpaca.markets/docs/non-trade-activities-for-option-events)

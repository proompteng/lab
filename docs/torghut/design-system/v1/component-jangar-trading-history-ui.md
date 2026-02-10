# Component: Jangar Trading History UI

## Status
- Version: `v1`
- Last updated: **2026-02-10**
- Implemented: PR #2958 (merged **2026-02-10**) - `feat(jangar): add torghut trading history UI`
- Source of truth (Torghut config): `argocd/applications/torghut/**`
- Source of truth (Torghut audit data): Torghut Postgres (`strategies`, `trade_decisions`, `executions`, `position_snapshots`, `llm_decision_reviews`)

## Purpose
Provide a read-only Jangar UI surface that answers the operational question:

- Is the current Torghut strategy profitable (per trading day, per strategy)?
- What drove performance (fills, holdings, risk/LLM/broker rejections)?

This is explicitly part of the Torghut production system because the UI is how humans decide whether to:

- keep a strategy enabled,
- change risk limits/universe,
- investigate broker/LLM failures,
- or disable trading.

## Non-goals
- Executing trades or changing Torghut strategy config from Jangar (read-only).
- Full accounting (dividends, fees, borrow costs, corporate actions).
- Long-horizon backtesting (see `v1/backtesting-and-simulation.md`).

## Placement (Jangar UI)
Jangar already has a **Torghut** sidebar group (`services/jangar/src/components/app-sidebar.tsx`) with:

- `/torghut/symbols`
- `/torghut/visuals`

Add:

- `/torghut/trading` (label: `Trading`)

## Data sources (authoritative)
Torghut Postgres tables (see `services/torghut/app/models/entities.py`):

- `strategies`
- `trade_decisions` (decision lifecycle + rejection reasons)
- `executions` (orders + fill state)
- `position_snapshots` (account equity curve + positions JSON)
- `llm_decision_reviews` (AI advisory audit trail)

Optional supporting context (not required for MVP):

- ClickHouse TA signals (already accessible from Jangar via `/api/torghut/ta/*`) for chart overlays.

## Trading day semantics
The UI must define “trading day” unambiguously:

- Default timezone: `America/New_York` (calendar day buckets).
- Backend queries filter using UTC timestamps computed from the selected ET day.
- UI displays both:
- selected ET day, and
- the computed `[startUtc, endUtc)` interval used for queries.

## Profitability definitions (MVP)
The UI should show two complementary views:

1. **Realized PnL (strategy-attributable)** from filled executions.
   - Join `executions` -> `trade_decisions` -> `strategies`.
   - Compute realized PnL using an average-cost position model per `(strategy_id, symbol)`:
   - buy increases position and cost basis
   - sell closes (part of) a long position and realizes PnL for that closed quantity
2. **Equity delta (account-level)** from `position_snapshots` for the selected day/range.
   - This answers “did the account go up?” even if there are open positions.
   - Not strategy-attributable unless Torghut records per-strategy allocation.

Notes:

- MVP ignores fees and borrow costs.
- If Torghut later persists fees/commission/borrow costs, incorporate them into PnL.

## UI information architecture (MVP)
Route: `/torghut/trading`

Panels:

- Filters bar:
- Trading day picker (ET) and optional date range mode.
- Strategy selector (single-select initially; multi-select later).
- Optional: symbol filter (later).
- Summary:
- Realized PnL (selected strategy; plus aggregate across selected strategies if multi-select).
- Filled execution count.
- Rejected decision count (with top reasons).
- Win rate (definition must be explicit; MVP can compute per closed-lot or per sell fill).
- Equity delta (account-level).
- Charts:
- Equity curve (from `position_snapshots`).
- Realized PnL timeline or daily bars (in range mode).
- Tables:
- Filled executions (time, symbol, side, qty, avg_fill_price, decision id, strategy).
- Trade decisions (time, symbol, status, rationale, rejection reasons, LLM verdict summary).
- Diagnostics:
- Rejection reasons histogram (risk vs broker).
- LLM advisory health (reviews by verdict; circuit-open frequency inferred if needed).

## Jangar API surface (proposed)
Pattern alignment (existing in repo):

- UI routes: `services/jangar/src/routes/torghut/*`
- API routes: `services/jangar/src/routes/api/torghut/*`
- Server helpers: `services/jangar/src/server/*`

Add endpoints:

- `GET /api/torghut/trading/strategies`
  - list `{ id, name, enabled, base_timeframe, universe_symbols }`
- `GET /api/torghut/trading/days?start=YYYY-MM-DD&end=YYYY-MM-DD&tz=America%2FNew_York&strategyId=<uuid?>`
  - day buckets with counts + PnL summary
- `GET /api/torghut/trading/summary?day=YYYY-MM-DD&tz=...&strategyId=<uuid?>`
  - summary cards + chart series
- `GET /api/torghut/trading/executions?day=YYYY-MM-DD&tz=...&strategyId=<uuid?>&status=filled`
  - filled executions joined to decision + strategy
- `GET /api/torghut/trading/decisions?day=YYYY-MM-DD&tz=...&strategyId=<uuid?>&status=rejected`
  - decisions with rejection reasons + LLM summary

API constraints:

- Default result limit (e.g., 500 rows) + cursor pagination.
- Always require at least a day or a bounded date range.
- Never allow “unbounded query of all trade_decisions”.

## Torghut DB connectivity (Jangar)
Jangar needs read-only access to Torghut Postgres.

Constraints:

- Use a dedicated read-only user for cross-namespace access.
- Do not rely on Torghut’s CNPG app credentials outside the Torghut namespace.

Implementation shape:

- Add `TORGHUT_DB_DSN` (read-only) to Jangar runtime configuration (sealed secret + env var).
- Add a small DB module in Jangar to query Torghut Postgres with strict timeouts.

## Query sketches (Torghut DB)
Filled executions for `[dayStartUtc, dayEndUtc)`:

```sql
select
  e.id,
  e.created_at,
  e.updated_at,
  e.symbol,
  e.side,
  e.filled_qty,
  e.avg_fill_price,
  td.id as trade_decision_id,
  td.created_at as decision_created_at,
  s.id as strategy_id,
  s.name as strategy_name
from executions e
join trade_decisions td on td.id = e.trade_decision_id
join strategies s on s.id = td.strategy_id
where e.status = 'filled'
and e.created_at >= $dayStartUtc
and e.created_at < $dayEndUtc
and ($strategyId is null or s.id = $strategyId)
order by e.created_at asc;
```

Rejected decisions and reasons:

```sql
select
  td.id,
  td.created_at,
  td.symbol,
  td.timeframe,
  td.status,
  td.rationale,
  td.decision_json->'risk_reasons' as risk_reasons,
  s.id as strategy_id,
  s.name as strategy_name
from trade_decisions td
join strategies s on s.id = td.strategy_id
where td.status = 'rejected'
and td.created_at >= $dayStartUtc
and td.created_at < $dayEndUtc
and ($strategyId is null or s.id = $strategyId)
order by td.created_at desc;
```

Equity curve:

```sql
select
  as_of,
  alpaca_account_label,
  equity,
  cash,
  buying_power
from position_snapshots
where as_of >= $dayStartUtc
and as_of < $dayEndUtc
order by as_of asc;
```

## PnL computation notes (MVP)
Location: Jangar server helper (pure function) + unit tests.

Algorithm:

- Input: sorted filled executions with `(ts, strategyId, symbol, side, qty, price)`.
- State per `(strategyId, symbol)`:
- `positionQty`
- `avgCost`
- On buy: update weighted `avgCost`, increase `positionQty`.
- On sell:
- if `positionQty > 0`, realize `(sellPrice - avgCost) * qtyClosed` for `qtyClosed=min(positionQty, sellQty)`.
- reduce `positionQty` by `qtyClosed`.

Guards:

- If shorts are disabled (Torghut default `TRADING_ALLOW_SHORTS=false`), a sell that exceeds the long position should not fill; treat it as a data-quality anomaly and surface in the UI.

## Short selling via Alpaca (research summary)
Alpaca supports short selling for equities when:

- the account is margin-enabled and eligible, and
- the security is shortable (typically easy-to-borrow / ETB).

References (official / support docs):

- Alpaca Trading API: “Short Selling” docs: https://docs.alpaca.markets/docs/short-selling
- Alpaca Trading API: “Margin and Short Selling” docs: https://docs.alpaca.markets/docs/margin-and-short-selling
- Alpaca paper trading overview: https://docs.alpaca.markets/docs/paper-trading
- Alpaca support: short-selling fees and ETB/HTB behavior: https://support.alpaca.markets/support/what-are-the-fees-for-short-selling

Implications for Torghut:

- `shorts_not_allowed` is a Torghut policy gate, not necessarily an Alpaca limitation.
- If enabling shorts, Torghut should also gate on:
- Alpaca account eligibility (margin enabled),
- symbol shortability (ETB),
- and a risk model that accounts for short exposure.

## Risks / open questions
- `executions` lacks an explicit `filled_at` timestamp; for UI timelines, prefer parsing from `raw_order` if present, else fall back to `updated_at`.
- Equity delta is account-level and can diverge from realized PnL if positions remain open at day end.
- Data volume: `trade_decisions` can be high-cardinality; APIs must paginate and bound by day/range.
- Multi-strategy attribution remains approximate unless Torghut records allocation or sub-accounts.

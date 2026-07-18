# Torghut

Torghut is the equity trading runtime for Alpaca. It consumes accepted technical-analysis signals, evaluates enabled
strategies, sizes active decisions from the live account, submits orders through the order firewall, and persists the
decision, execution, TCA, and ledger records.

The production runtime is deliberately narrow:

- one scheduler process per account;
- Alpaca is the only live execution route;
- simulation runs only when `TRADING_SIMULATION_ENABLED=true`;
- accepted signal freshness, account state, open orders, and positions are checked before live submission;
- research and paper evidence do not grant or size live capital.

## HTTP Surface

- `GET /healthz`: process liveness for Kubernetes and Knative.
- `GET /readyz`: dependency, accepted-source freshness, universe, broker route, and capital-control readiness.
- `GET /trading/status`: bounded operational status for the scheduler, live gate, capital controls, execution, TCA,
  and ledger reconciliation.
- `GET /metrics`: Prometheus metrics.

Removed trading endpoints return `404`. In particular, `/trading/proofs` and `/trading/health` are not runtime
dependencies.

## Live Capital Contract

Production sizing uses the latest Alpaca account, positions, and open orders before every decision. Remaining open
order quantity is projected into portfolio exposure before any new quantity is admitted.

The live limits are:

- gross exposure ceiling: `1.0 * equity`;
- absolute net exposure ceiling: `0.5 * equity`;
- absolute per-symbol exposure ceiling: `0.5 * equity`;
- buying-power reserve: `10%`;
- daily equity loss stop: `1%` from the first session snapshot;
- persistent equity drawdown stop: `5%` from the stored high-water mark;
- no new exposure at or after `15:30 America/New_York`;
- closeout starts at `15:45 America/New_York`;
- flat exposure must be confirmed by `15:50 America/New_York`.

The gross capacity for a decision is therefore bounded by both the configured gross ceiling and the broker:

```text
gross_target = min(equity, current_gross + 0.9 * available_buying_power)
```

The allocator only sizes active strategy signals. It does not create orders to consume unused capacity. Pair entries
receive equal dollar reservations; the net-reducing leg is sent first, and any missing or unbalanced leg triggers the
capital stop and account closeout.

## Order Lifecycle

Live entries and exits use SIP quote data and marketable limit orders. An unfilled limit is observed, canceled, and
confirmed terminal before replacement. Replacement rules are:

- check every `2` seconds;
- at most `3` submissions;
- at most `8` basis points adverse movement from the initial limit;
- submit only the quantity still unfilled after terminal cancel confirmation.

Unknown order state, failed cancellation, stale accepted data, broker/account read failure, exposure breach,
unbalanced pair execution, equity stop, or closeout failure latches the emergency stop. The runtime cancels open
orders, closes positions with bounded marketable limits, and blocks new exposure. It never falls back from live Alpaca
to an after-hours simulation route.

## Local Development

Use the repository Nix shell when available, then install the locked development environment:

```bash
cd services/torghut
uv sync --frozen --extra dev
```

Start the API:

```bash
uv run --frozen uvicorn app.main:app --host 0.0.0.0 --port 8181
```

`DB_DSN` defaults to the local Compose PostgreSQL instance. Broker credentials are required only for broker-backed
runtime checks.

## Required Validation

Run all Pyright profiles used by CI:

```bash
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen pyright --project pyrightconfig.alpha.strict.json
uv run --frozen pyright --project pyrightconfig.scripts.strict.json
```

Run formatting, lint, bytecode, and structural checks:

```bash
uv run --frozen ruff format --check app tests scripts migrations
uv run --frozen ruff check app tests scripts migrations
uv run --frozen python -m compileall app scripts tests
uv run --frozen python scripts/run_pylint_torghut_structural_gate.py
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
uv run --frozen python scripts/check_migration_graph.py
uv run --frozen vulture --config pyproject.toml
```

Run the debt ratchet and tests:

```bash
uv run --frozen python scripts/measure_torghut_tech_debt.py \
  --baseline config/quality/tech-debt-baseline.json \
  --enforce-ratchet \
  --format markdown
uv run --frozen pytest
```

The file-length gate blocks Python files over 1,000 lines. The structural gate blocks source-string execution,
wildcard imports, dynamic module facades, vague split names, and broad file-level lint or type suppressions.

## Production Configuration

The live GitOps manifest owns the production values. The key settings are:

```text
TRADING_MODE=live
TRADING_PIPELINE_MODE=simple
TRADING_STRATEGY_RUNTIME_MODE=scheduler_v3
TRADING_ENABLED=true
TRADING_SIMPLE_SUBMIT_ENABLED=true
TRADING_LIVE_SUBMIT_ENABLED=true
TRADING_SIGNAL_ALLOWED_SOURCES=ta
TRADING_ALPACA_QUOTE_FEED=iex
TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY=0.50
TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY=0.50
TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY=1.0
TRADING_SIMPLE_MAX_NET_EXPOSURE_PCT_EQUITY=0.50
TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS=1000
TRADING_DAILY_LOSS_STOP_PCT_EQUITY=0.01
TRADING_PERSISTENT_DRAWDOWN_STOP_PCT_EQUITY=0.05
TRADING_NEW_EXPOSURE_CUTOFF_TIME_ET=15:30:00
TRADING_FLATTEN_START_TIME_ET=15:45:00
TRADING_FLAT_CONFIRMATION_TIME_ET=15:50:00
TRADING_PAIR_DELTA_TOLERANCE_BPS=8
```

Decision submissions make exactly one broker call after their durable I/O boundary. No runtime retry or repricing
configuration exists. Read-only recovery still scans the historical `-r2` and `-r3` broker idempotency keys without
authorizing new attempts. Emergency closeout submissions also require durable unlinked, risk-reducing receipts and a
fresh broker-position check; cancel, replace, and recovery fencing remain unavailable until their roadmap slices.

Do not add fixed live notional, paper probe, target-plan, proof-floor, or configured-collection settings. Historical
simulation may retain deterministic fixed sizing for replay compatibility, but those values must not enter live order
sizing.

## Database And Reconciliation

Alembic owns the PostgreSQL schema. Validate the migration graph before pushing:

```bash
uv run --frozen python scripts/check_migration_graph.py
```

The scheduler persists decisions and execution state, consumes order-feed updates, computes TCA, and reconciles broker
orders. TigerBeetle journal jobs remain separate GitOps workloads. A live session is complete only when Alpaca,
PostgreSQL execution rows, TCA, and TigerBeetle-derived ledger records agree.

## Whitepaper Worker

The optional whitepaper Kafka worker is started inside the service only when its workflow settings are enabled. It has
no HTTP route and no authority over live order sizing or submission.

## Strategy Autoresearch

The strategy autoresearch loop is research-only and cannot grant live capital. A candidate satisfies the research
objective only after terminal validation. A discarded, vetoed, malformed, or duplicate candidate may record that its
raw metrics crossed the target, but it cannot set `objective_met=true` or stop the search.

Every run writes `search-decisions.jsonl` with the reason for each continuation or stop and atomically updates
`checkpoint.json` after committed setup and frontier boundaries. Resume an interrupted or failed run with the same
program and data-affecting arguments, replacing `--output-dir` with the existing run folder:

```bash
uv run --frozen python scripts/run_strategy_autoresearch_loop.py \
  --program <program.yaml> \
  --resume-run-root <run-root> \
  <original-data-arguments>
```

Resume refuses a corrupt checkpoint, a changed program, or a changed execution contract before running another
frontier. A completed checkpoint returns its existing summary without replaying work. Credentials are supplied again
through arguments or environment variables and are never persisted in the checkpoint.

## Deployment

Torghut is deployed only through GitHub Actions and Argo CD:

1. Merge a green service PR.
2. Wait for the image build and automatic promotion PR.
3. Verify and merge the promotion PR.
4. Wait for the Argo application to become `Synced` and `Healthy`.
5. Verify the Knative revision and image digest.
6. Read `/readyz`, `/trading/status`, and `/metrics` from the active revision.
7. During the next regular session, verify order notional, fills, slippage, exposure, reconciliation, loss controls,
   and scheduled closeout.

Do not deploy the service directly from a local worktree.

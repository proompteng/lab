# torghut

FastAPI service scaffold for an autonomous Alpaca paper trading bot powered by Codex.

## Local dev (uv-native)
```bash
cd services/torghut
uv venv .venv
source .venv/bin/activate
uv pip install .

# configure env (DB_DSN defaults to local compose: postgresql+psycopg://torghut:torghut@localhost:15438/torghut)
export APP_ENV=dev
# optional:
# export DB_DSN=...               # override if not using local compose
# export APCA_API_KEY_ID=...
# export APCA_API_SECRET_KEY=...
# export APCA_API_BASE_URL=...

# shortcuts
# normal server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8181

# hot reload
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8181

# type checking
uv run pyright
```

Health checks:
- `GET /healthz` – liveness (default port 8181)
- `GET /db-check` – requires reachable Postgres at `DB_DSN` (default port 8181)

## Feature flags (Flipt)
- Torghut runtime gates are resolved via Flipt boolean evaluations when `TRADING_FEATURE_FLAGS_ENABLED=true`.
- Configure:
  - `TRADING_FEATURE_FLAGS_URL` (feature-flags service URL)
  - `TRADING_FEATURE_FLAGS_NAMESPACE` (default `default`)
  - `TRADING_FEATURE_FLAGS_ENTITY_ID` (default `torghut`)
  - `TRADING_FEATURE_FLAGS_TIMEOUT_MS` (default `500`)
- Canonical flag inventory is in `argocd/applications/feature-flags/gitops/default/features.yaml` (`torghut_*` keys).
- Migration and rollout runbook: `docs/torghut/feature-flags-rollout.md`.

## Deploy automation (main -> Argo CD)
- `torghut-ci` validates code changes on PR and push.
- `torghut-build-push` runs on `main` merges touching Torghut sources/scripts, builds/pushes image, and emits a release contract artifact.
- `torghut-release` consumes that artifact, updates `argocd/applications/torghut/knative-service.yaml` digest/version metadata, and opens a release PR (`codex/torghut-release-<tag>`).
- `torghut-deploy-automerge` enables squash auto-merge for eligible release PRs.
- Migration safety gate: if the promoted source commit touches `services/torghut/migrations/**`, the release PR is created as draft with `do-not-automerge` and requires manual approval before merge.

## Order-feed ingestion (v3 execution accuracy)
- `TRADING_ORDER_FEED_ENABLED=true` enables Kafka order-update ingestion in the main trading runtime.
- `TRADING_ORDER_FEED_BOOTSTRAP_SERVERS=<host:port,...>` must be set when enabled.
- `TRADING_ORDER_FEED_TOPIC` defaults to `torghut.trade-updates.v1`.
- `TRADING_ORDER_FEED_GROUP_ID` defaults to `torghut-order-feed-v1`.
- `TRADING_ORDER_FEED_CLIENT_ID` defaults to `torghut-order-feed`.
- `TRADING_ORDER_FEED_AUTO_OFFSET_RESET` supports `latest` (default) or `earliest`.
- `TRADING_ORDER_FEED_POLL_MS` (default `250`) controls poll latency.
- `TRADING_ORDER_FEED_BATCH_SIZE` (default `200`) controls max records per poll.

Metrics emitted on `/metrics`:
- `torghut_trading_order_feed_messages_total`
- `torghut_trading_order_feed_events_persisted_total`
- `torghut_trading_order_feed_duplicates_total`
- `torghut_trading_order_feed_out_of_order_total`
- `torghut_trading_order_feed_missing_fields_total`
- `torghut_trading_order_feed_apply_updates_total`
- `torghut_trading_order_feed_consumer_errors_total`

## v3 autonomous lane (phase 1/2 foundation)
Deterministic research -> gate evaluation -> paper candidate patch pipeline:

```bash
cd services/torghut
uv run python scripts/run_autonomous_lane.py \
  --signals tests/fixtures/walkforward_signals.json \
  --strategy-config config/autonomous-strategy-sample.yaml \
  --gate-policy config/autonomous-gate-policy.json \
  --output-dir artifacts/autonomy-lane
```

Outputs:
- `artifacts/autonomy-lane/research/candidate-spec.json`
- `artifacts/autonomy-lane/backtest/walkforward-results.json`
- `artifacts/autonomy-lane/backtest/evaluation-report.json`
- `artifacts/autonomy-lane/gates/gate-evaluation.json`
- `artifacts/autonomy-lane/paper-candidate/strategy-configmap-patch.yaml` (only when paper gates pass)

Safety defaults:
- live promotions are blocked unless gate policy explicitly enables them and approval token requirements are satisfied.
- LLM remains bounded/advisory; deterministic risk/firewall controls remain final authority.

## v3 orchestration guard CLI
Validate stage transitions and retry/failure actions with policy-driven guardrails:

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py check-transition \
  --state artifacts/orchestration/candidate-state.json \
  --candidate-id cand-abc123 \
  --run-id run-abc123 \
  --from-stage gate-evaluation \
  --to-stage shadow-paper \
  --previous-artifact artifacts/gates/cand-abc123/report.json \
  --previous-gate-passed \
  --risk-controls-passed \
  --execution-controls-passed \
  --mode gitops
```

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py evaluate-failure \
  --state artifacts/orchestration/candidate-state.json \
  --stage candidate-build \
  --failure-class transient \
  --attempt 2
```

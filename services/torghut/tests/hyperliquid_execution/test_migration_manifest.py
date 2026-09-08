"""Migration and manifest contract tests for Hyperliquid execution v2."""

from __future__ import annotations

from pathlib import Path

from tests.migration_testing import migration_path


REPO_ROOT = Path(__file__).resolve().parents[4]
MIGRATION = migration_path("0056_hyperliquid_execution_v2_hard_reset.py")
MULTIFACTOR_MIGRATION = migration_path("0057_generic_multifactor_machine.py")
CONFIGMAP = REPO_ROOT / "argocd/applications/torghut-hyperliquid-runtime/configmap.yaml"
DEPLOYMENT = (
    REPO_ROOT / "argocd/applications/torghut-hyperliquid-runtime/deployment.yaml"
)
DB_MIGRATIONS_JOB = (
    REPO_ROOT / "argocd/applications/torghut-hyperliquid-runtime/db-migrations-job.yaml"
)


def test_hard_reset_migration_drops_v1_tables_and_creates_v2_tables() -> None:
    text = MIGRATION.read_text()

    assert '"hyperliquid_runtime_orders"' in text
    assert '"hyperliquid_runtime_tigerbeetle_refs"' in text
    assert "DROP TABLE IF EXISTS {table_name} CASCADE" in text
    assert "hyperliquid_execution_cycles" in text
    assert "hyperliquid_execution_orders" in text
    assert "hyperliquid_execution_performance_snapshots" in text


def test_generic_multifactor_migration_creates_proof_tables() -> None:
    text = MULTIFACTOR_MIGRATION.read_text()

    assert 'down_revision = "0056_hyperliquid_execution_v2_hard_reset"' in text
    for table_name in (
        "multifactor_runs",
        "multifactor_factor_snapshots",
        "multifactor_forecasts",
        "multifactor_risk_forecasts",
        "multifactor_portfolio_targets",
        "multifactor_execution_intents",
        "multifactor_attribution_snapshots",
    ):
        assert table_name in text


def test_manifest_uses_v2_command_and_env_prefix_only() -> None:
    configmap = CONFIGMAP.read_text()
    deployment = DEPLOYMENT.read_text()

    assert "app.hyperliquid_execution.api:app" in deployment
    assert "revisionHistoryLimit: 2" in deployment
    assert "HYPERLIQUID_EXECUTION_ORDER_POLICY: marketable_ioc" in configmap
    assert 'HYPERLIQUID_EXECUTION_TRADING_ENABLED: "false"' in configmap
    assert "HYPERLIQUID_EXECUTION_ACCOUNT_LABEL: hyperliquid-testnet" in configmap
    assert 'HYPERLIQUID_EXECUTION_ORDER_TTL_SECONDS: "10"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD: "12"' in configmap
    assert 'HYPERLIQUID_EXECUTION_TARGET_MARGIN_UTILIZATION: "0.35"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MAX_SYMBOL_MARGIN_UTILIZATION: "0.08"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MAX_ORDER_MARGIN_UTILIZATION: "0.02"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS: "1000"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MIN_AFTER_COST_EDGE_BPS: "4"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MIN_EDGE_COST_RATIO: "2"' in configmap
    assert (
        'HYPERLIQUID_EXECUTION_MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H: "1"' in configmap
    )
    assert (
        'HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES: "300"' in configmap
    )
    assert 'HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SIDE_FLIP: "900"' in configmap
    assert 'HYPERLIQUID_EXECUTION_BROKER_MUTATION_RECOVERY_ENABLED: "true"' in configmap
    assert (
        'HYPERLIQUID_EXECUTION_BROKER_MUTATION_RECOVERY_REQUEST_TIMEOUT_SECONDS: "10"'
        in configmap
    )
    assert (
        'HYPERLIQUID_EXECUTION_BROKER_MUTATION_RECOVERY_INTERVAL_SECONDS: "60"'
        in configmap
    )
    assert 'HYPERLIQUID_EXECUTION_MAX_DAILY_LOSS_USD: "100"' in configmap
    assert (
        'HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED: "true"'
        in configmap
    )
    assert "hyperliquid-testnet-loss-cap-20260705a" in deployment
    assert "hyperliquid-profitability-freeze-20260705a" not in deployment
    assert "HYPERLIQUID_RUNTIME_" not in configmap
    assert "HYPERLIQUID_EXECUTION_MAX_ORDER_NOTIONAL_USD" not in configmap
    assert "HYPERLIQUID_EXECUTION_MAX_GROSS_EXPOSURE_USD" not in configmap
    assert "HYPERLIQUID_EXECUTION_MAX_SYMBOL_EXPOSURE_USD" not in configmap


def test_runtime_migration_hook_uses_image_path_binaries() -> None:
    manifest = DB_MIGRATIONS_JOB.read_text()

    assert "workingDir: /app" in manifest
    assert "name: PYTHONPATH\n              value: /app" in manifest
    assert "until python - <<'PY'" in manifest
    assert "alembic -c /app/alembic.ini upgrade heads" in manifest
    assert "/opt/venv/bin/" not in manifest

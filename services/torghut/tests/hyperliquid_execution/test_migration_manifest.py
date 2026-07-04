"""Migration and manifest contract tests for Hyperliquid execution v2."""

from __future__ import annotations

from pathlib import Path


TORGHUT_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(__file__).resolve().parents[4]
MIGRATION = (
    TORGHUT_ROOT / "migrations/versions/0056_hyperliquid_execution_v2_hard_reset.py"
)
MULTIFACTOR_MIGRATION = (
    TORGHUT_ROOT / "migrations/versions/0057_generic_multifactor_machine.py"
)
CONFIGMAP = REPO_ROOT / "argocd/applications/torghut-hyperliquid-runtime/configmap.yaml"
DEPLOYMENT = (
    REPO_ROOT / "argocd/applications/torghut-hyperliquid-runtime/deployment.yaml"
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
    assert "HYPERLIQUID_EXECUTION_MAKER_TIF: Ioc" in configmap
    assert 'HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS: "10"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MAX_GROSS_EXPOSURE_USD: "250"' in configmap
    assert 'HYPERLIQUID_EXECUTION_MAX_SYMBOL_EXPOSURE_USD: "50"' in configmap
    assert (
        'HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED: "true"'
        in configmap
    )
    assert (
        "hyperliquid-execution-v2-testnet-cap-250-reduce-only-20260703a" in deployment
    )
    assert "HYPERLIQUID_RUNTIME_" not in configmap

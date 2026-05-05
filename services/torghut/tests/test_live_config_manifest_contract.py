from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Iterable, Mapping, cast
from unittest import TestCase

from pydantic import ValidationError
from yaml import safe_load

from app.config import Settings
from app.trading.llm.dspy_programs.runtime import DSPyReviewRuntime


_LIVE_SIGNAL_COVERED_CHIP_UNIVERSE = (
    "AMAT",
    "AMD",
    "AVGO",
    "INTC",
    "MU",
    "NVDA",
)
_CHIP_UNIVERSE_SYMBOLS = set(_LIVE_SIGNAL_COVERED_CHIP_UNIVERSE)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _manifest_bool(env: dict[str, object], key: str) -> bool:
    raw = env.get(key)
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() == "true"


def _load_yaml_mapping(relative_path: str) -> dict[str, object]:
    manifest_path = _repo_root() / relative_path
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise AssertionError(f"{relative_path} did not parse to a mapping")
    return manifest


def _load_torghut_knative_manifest() -> dict[str, object]:
    return _load_yaml_mapping("argocd/applications/torghut/knative-service.yaml")


def _load_knative_env(relative_path: str) -> dict[str, object]:
    manifest = _load_yaml_mapping(relative_path)
    containers = (
        manifest.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers:
        raise AssertionError(f"{relative_path} missing spec.template.spec.containers")

    first_container = containers[0]
    env_entries = first_container.get("env", [])
    env: dict[str, object] = {}
    for item in env_entries:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str):
            continue
        if "value" in item:
            raw_value = item["value"]
            env[name] = raw_value if isinstance(raw_value, str) else str(raw_value)
    return env


def _load_torghut_knative_env() -> dict[str, object]:
    return _load_knative_env("argocd/applications/torghut/knative-service.yaml")


def _load_torghut_feature_flags() -> dict[str, object]:
    manifest_path = (
        _repo_root()
        / "argocd"
        / "applications"
        / "feature-flags"
        / "gitops"
        / "default"
        / "features.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    flags = manifest.get("flags")
    if not isinstance(flags, list):
        raise AssertionError("features.yaml missing flags list")

    feature_lookup: dict[str, object] = {}
    for item in flags:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if isinstance(key, str):
            feature_lookup[key] = item
    return feature_lookup


def _load_torghut_strategy_catalog() -> list[dict[str, object]]:
    manifest_path = (
        _repo_root() / "argocd" / "applications" / "torghut" / "strategy-configmap.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise AssertionError("strategy-configmap.yaml did not parse to a mapping")
    data = manifest.get("data")
    if not isinstance(data, dict):
        raise AssertionError("strategy-configmap.yaml missing data mapping")
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        raise AssertionError("strategy-configmap.yaml missing strategies.yaml")
    catalog = safe_load(strategies_yaml)
    if not isinstance(catalog, dict):
        raise AssertionError("strategies.yaml did not parse to a mapping")
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        raise AssertionError("strategies.yaml missing strategies list")
    return [
        dict(cast(Mapping[str, object], item))
        for item in strategies
        if isinstance(item, Mapping)
    ]


def _csv_symbols(value: object) -> list[str]:
    return [
        symbol.strip().upper()
        for symbol in str(value or "").split(",")
        if symbol.strip()
    ]


def _strategy_decimal(strategy: Mapping[str, object], key: str) -> Decimal | None:
    value = strategy.get(key)
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _params(strategy: Mapping[str, object]) -> Mapping[str, object]:
    raw_params = strategy.get("params")
    return (
        cast(Mapping[str, object], raw_params)
        if isinstance(raw_params, Mapping)
        else {}
    )


def _assert_chip_universe(
    test_case: TestCase, symbols: Iterable[object], *, context: str
) -> None:
    normalized = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    test_case.assertTrue(normalized, f"{context} missing universe symbols")
    test_case.assertLessEqual(
        len(normalized), 12, f"{context} has more than 12 symbols"
    )
    test_case.assertEqual(
        len(normalized),
        len(set(normalized)),
        f"{context} has duplicate symbols",
    )
    test_case.assertEqual(
        sorted(set(normalized) - _CHIP_UNIVERSE_SYMBOLS),
        [],
        f"{context} contains symbols without live chip TA signal coverage",
    )


def _assert_exact_live_signal_universe(
    test_case: TestCase, symbols: Iterable[object], *, context: str
) -> None:
    normalized = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    _assert_chip_universe(test_case, normalized, context=context)
    test_case.assertEqual(
        tuple(normalized),
        _LIVE_SIGNAL_COVERED_CHIP_UNIVERSE,
        f"{context} does not match the live-signal-covered chip universe",
    )


class TestLiveConfigManifestContract(TestCase):
    def test_knative_env_wiring_is_safe_live_defaults(self) -> None:
        env = _load_torghut_knative_env()
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_universe_source, "jangar")
        self.assertEqual(env.get("TRADING_STRATEGY_SCHEDULER_ENABLED"), "true")
        self.assertFalse(settings.trading_autonomy_enabled)
        self.assertFalse(settings.trading_autonomy_allow_live_promotion)
        self.assertFalse(settings.trading_evidence_continuity_enabled)
        self.assertFalse(settings.trading_emergency_stop_enabled)
        self.assertFalse(settings.trading_feature_flags_enabled)
        self.assertFalse(settings.trading_execution_advisor_enabled)
        self.assertFalse(settings.trading_execution_advisor_live_apply_enabled)
        self.assertEqual(env.get("LLM_ENABLED"), "false")
        self.assertFalse(settings.llm_enabled)
        self.assertEqual(env.get("LLM_DSPY_RUNTIME_MODE"), "disabled")
        self.assertEqual(settings.llm_dspy_runtime_mode, "disabled")
        self.assertFalse(settings.posthog_enabled)
        self.assertTrue(settings.trading_fractional_equities_enabled)
        self.assertTrue(settings.trading_universe_require_non_empty_jangar)
        self.assertTrue(settings.trading_universe_static_fallback_enabled)
        self.assertEqual(settings.trading_universe_max_stale_seconds, 900)
        self.assertEqual(
            settings.trading_jangar_symbols_url,
            "http://jangar.jangar.svc.cluster.local/api/torghut/symbols?assetClass=equity&format=compact",
        )
        self.assertEqual(
            settings.trading_jangar_control_plane_status_url,
            "http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents",
        )
        self.assertIsNone(settings.trading_jangar_quant_health_url)
        self.assertIsNone(settings.trading_market_context_url)
        self.assertEqual(
            set(settings.trading_universe_static_fallback_symbols),
            _CHIP_UNIVERSE_SYMBOLS,
        )
        self.assertNotIn("TRADING_FEATURE_FLAGS_URL", env)
        self.assertNotIn("TRADING_FORECAST_SERVICE_URL", env)
        self.assertNotIn("TRADING_LEAN_RUNNER_URL", env)
        self.assertNotIn("TRADING_MARKET_CONTEXT_URL", env)
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL"),
            "http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents",
        )
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS"), "15"
        )
        self.assertEqual(env.get("TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS"), "10")
        self.assertNotIn("JANGAR_BASE_URL", env)

    def test_strategy_catalog_universes_are_chip_only(self) -> None:
        for strategy in _load_torghut_strategy_catalog():
            raw_symbols = strategy.get("universe_symbols")
            self.assertIsInstance(
                raw_symbols,
                list,
                f"{strategy.get('name')} missing explicit universe_symbols",
            )
            _assert_exact_live_signal_universe(
                self,
                cast(list[object], raw_symbols),
                context=f"strategy {strategy.get('name')}",
            )

    def test_runtime_symbol_sources_use_live_signal_universe(self) -> None:
        live_env = _load_torghut_knative_env()
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        ws_config = _load_yaml_mapping("argocd/applications/torghut/ws/configmap.yaml")
        ws_data = ws_config.get("data")
        self.assertIsInstance(ws_data, Mapping)

        _assert_exact_live_signal_universe(
            self,
            _csv_symbols(live_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="live static fallback symbols",
        )
        _assert_exact_live_signal_universe(
            self,
            _csv_symbols(sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="sim static fallback symbols",
        )
        _assert_exact_live_signal_universe(
            self,
            _csv_symbols(cast(Mapping[str, object], ws_data).get("SYMBOLS")),
            context="torghut-ws subscription symbols",
        )

    def test_migration_job_prepares_sim_database_before_sim_upgrade(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/db-migrations-job.yaml"
        )
        containers = (
            manifest.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertTrue(containers)
        container = containers[0]
        args = "\n".join(str(item) for item in container.get("args", []))
        env_names = {
            item.get("name")
            for item in container.get("env", [])
            if isinstance(item, Mapping)
        }

        self.assertIn("TORGHUT_POSTGRES_ADMIN_URI", env_names)
        self.assertIn("TORGHUT_SIM_ADMIN_DSN", env_names)
        self.assertIn("database_url(admin_uri, 'postgres')", args)
        self.assertIn("CREATE DATABASE", args)
        self.assertIn("GRANT ALL PRIVILEGES ON DATABASE", args)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS vector", args)
        self.assertIn("postgresql+psycopg://", args)
        self.assertIn("ALTER %s %s OWNER TO %I", args)
        self.assertIn("pg_get_userbyid(c.relowner) <> target_role", args)
        self.assertIn("target_role_literal", args)
        self.assertIn('DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic', args)
        self.assertIn("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public", args)
        self.assertIn("granted simulation runtime privileges", args)
        self.assertLess(
            args.index("CREATE EXTENSION IF NOT EXISTS vector"),
            args.index("ALTER %s %s OWNER TO %I"),
        )
        self.assertLess(
            args.index("ALTER %s %s OWNER TO %I"),
            args.index(
                'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini upgrade heads'
            ),
        )
        self.assertLess(
            args.index(
                'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini upgrade heads'
            ),
            args.index("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public"),
        )

    def test_profitability_sweep_universes_are_chip_only(self) -> None:
        trading_config_dir = (
            _repo_root() / "services" / "torghut" / "config" / "trading"
        )
        checked_universe_sets = 0
        for path in sorted(trading_config_dir.glob("profitability-frontier*.yaml")):
            payload = safe_load(path.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict, f"{path} did not parse to a mapping")
            overrides = cast(Mapping[str, object], payload).get("strategy_overrides")
            if not isinstance(overrides, Mapping):
                continue
            raw_universe_sets = overrides.get("universe_symbols")
            if raw_universe_sets is None:
                continue
            self.assertIsInstance(
                raw_universe_sets,
                list,
                f"{path} missing strategy_overrides.universe_symbols",
            )
            for index, raw_symbols in enumerate(cast(list[object], raw_universe_sets)):
                self.assertIsInstance(
                    raw_symbols,
                    list,
                    f"{path} universe_symbols[{index}] is not a list",
                )
                _assert_exact_live_signal_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{path.name} universe_symbols[{index}]",
                )
                checked_universe_sets += 1
        self.assertGreater(checked_universe_sets, 0)

    def test_candidate_records_are_not_left_on_mixed_large_cap_universes(self) -> None:
        candidates_dir = (
            _repo_root() / "services" / "torghut" / "config" / "trading" / "candidates"
        )
        for path in sorted(candidates_dir.glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict, f"{path} did not parse to a mapping")
            candidate_strategy = payload.get("candidate_strategy")
            self.assertIsInstance(
                candidate_strategy,
                Mapping,
                f"{path} missing candidate_strategy",
            )
            raw_symbols = cast(Mapping[str, object], candidate_strategy).get(
                "universe_symbols"
            )
            self.assertIsInstance(
                raw_symbols,
                list,
                f"{path} missing candidate_strategy.universe_symbols",
            )
            _assert_exact_live_signal_universe(
                self,
                cast(list[object], raw_symbols),
                context=f"{path.name} candidate universe",
            )

    def test_live_manifest_does_not_import_autonomy_env_from(self) -> None:
        manifest = _load_torghut_knative_manifest()
        containers = (
            manifest.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertTrue(containers)
        first_container = containers[0]
        env_from = first_container.get("envFrom", [])
        self.assertEqual(env_from, [])

    def test_manifest_simple_lane_profile_is_enforced(self) -> None:
        env = _load_torghut_knative_env()
        self.assertTrue(_manifest_bool(env, "TRADING_ENABLED"))
        self.assertEqual(env.get("TRADING_MODE"), "live")
        self.assertEqual(env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertEqual(env.get("TRADING_UNIVERSE_SOURCE"), "jangar")
        self.assertFalse(_manifest_bool(env, "TRADING_AUTONOMY_ENABLED"))
        self.assertFalse(_manifest_bool(env, "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION"))
        self.assertFalse(_manifest_bool(env, "TRADING_KILL_SWITCH_ENABLED"))
        self.assertFalse(_manifest_bool(env, "TRADING_EMERGENCY_STOP_ENABLED"))
        self.assertNotIn("TRADING_EXECUTION_ADAPTER_POLICY", env)
        self.assertNotIn("TRADING_EXECUTION_ADAPTER", env)
        self.assertNotIn("TRADING_EXECUTION_FALLBACK_ADAPTER", env)

    def test_manifest_rollout_toggles_disable_execution_advisor(self) -> None:
        knative_env = _load_torghut_knative_env()
        self.assertEqual(knative_env.get("TRADING_EXECUTION_ADVISOR_ENABLED"), "false")
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED"),
            "false",
        )

    def test_feature_flags_defaults_keep_execution_advisor_disabled(self) -> None:
        flags = _load_torghut_feature_flags()

        def _require_flag_enabled_false(key: str) -> None:
            raw_flag = flags.get(key)
            self.assertIsInstance(raw_flag, dict)
            self.assertIn("enabled", raw_flag)
            self.assertIs(raw_flag.get("enabled"), False)

        _require_flag_enabled_false("torghut_trading_execution_advisor_enabled")
        _require_flag_enabled_false(
            "torghut_trading_execution_advisor_live_apply_enabled"
        )
        _require_flag_enabled_false(
            "torghut_trading_db_schema_graph_allow_divergence_roots"
        )
        _require_flag_enabled_false("torghut_llm_fail_open_live_approved")
        _require_flag_enabled_false("torghut_llm_shadow_mode")

    def test_strict_daily_profit_strategies_require_executable_live_proof(self) -> None:
        strategies = _load_torghut_strategy_catalog()
        strict_daily_profit_strategies = [
            strategy
            for strategy in strategies
            if "strict-daily-profit" in str(strategy.get("description") or "").lower()
        ]
        self.assertTrue(strict_daily_profit_strategies)

        for strategy in strict_daily_profit_strategies:
            if not _manifest_bool(strategy, "enabled"):
                continue

            params = _params(strategy)
            evidence_ref = str(
                params.get("executable_profit_evidence_ref") or ""
            ).strip()
            min_daily_net_pnl = params.get("executable_profit_min_daily_net_pnl")
            target_net_pnl = params.get("executable_profit_target_net_pnl_per_day")
            replay_buying_power = params.get("executable_replay_account_buying_power")
            replay_max_notional = params.get("executable_replay_max_notional_per_trade")
            max_notional_per_trade = _strategy_decimal(
                strategy, "max_notional_per_trade"
            )

            self.assertTrue(
                evidence_ref,
                f"{strategy.get('name')} is strict-daily-profit live-enabled without executable evidence ref",
            )
            self.assertGreaterEqual(
                Decimal(str(target_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is strict-daily-profit live-enabled without $300/day target proof",
            )
            self.assertGreaterEqual(
                Decimal(str(min_daily_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is strict-daily-profit live-enabled without every-day $300 proof",
            )
            self.assertIsNotNone(max_notional_per_trade)
            self.assertLessEqual(
                max_notional_per_trade or Decimal("0"),
                Decimal(str(replay_max_notional or "0")),
                f"{strategy.get('name')} live notional exceeds executable replay notional",
            )
            self.assertLessEqual(
                Decimal(str(replay_max_notional or "0")),
                Decimal(str(replay_buying_power or "0")),
                f"{strategy.get('name')} replay notional exceeds stated buying power",
            )

    def test_live_pass_through_with_strict_veto_profile_is_rejected(self) -> None:
        env = _load_torghut_knative_env()
        env["TRADING_MODE"] = "live"
        fail_open_env = dict(env)
        fail_open_env["LLM_ROLLOUT_STAGE"] = "stage3"
        fail_open_env["LLM_FAIL_MODE"] = "pass_through"
        fail_open_env["LLM_FAIL_MODE_ENFORCEMENT"] = "strict_veto"
        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "false"

        with self.assertRaises(ValidationError):
            Settings(**fail_open_env)

        fail_open_env["LLM_FAIL_MODE_ENFORCEMENT"] = "configured"
        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "true"
        approved_settings = Settings(**fail_open_env)
        self.assertEqual(
            approved_settings.llm_effective_fail_mode_for_current_rollout(),
            "pass_through",
        )
        fail_open_env["LLM_DSPY_RUNTIME_MODE"] = "active"
        fail_open_env["LLM_SHADOW_MODE"] = "false"
        fail_open_env["LLM_DSPY_ARTIFACT_HASH"] = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        approved_settings = Settings(**fail_open_env)
        cutover_allowed, cutover_reasons = (
            approved_settings.llm_dspy_cutover_migration_guard()
        )
        self.assertFalse(cutover_allowed)
        self.assertIn("dspy_cutover_requires_strict_veto_enforcement", cutover_reasons)

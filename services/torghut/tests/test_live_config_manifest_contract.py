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


_RESEARCHED_CHIP_TECH_UNIVERSE = (
    "NVDA",
    "AAPL",
    "AMZN",
    "GOOGL",
    "AVGO",
    "AMD",
    "ORCL",
    "INTC",
)
_LIVE_EXECUTION_CHIP_TECH_UNIVERSE = _RESEARCHED_CHIP_TECH_UNIVERSE
_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE = ("AAPL", "AMZN", "INTC", "NVDA")
_CHIP_UNIVERSE_SYMBOLS = set(_RESEARCHED_CHIP_TECH_UNIVERSE)
_LIVE_EXECUTION_CHIP_UNIVERSE_SYMBOLS = set(_LIVE_EXECUTION_CHIP_TECH_UNIVERSE)


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


def _load_torghut_clickhouse_manifest() -> dict[str, object]:
    return _load_yaml_mapping(
        "argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml"
    )


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


def _load_cronjob_container(
    relative_path: str,
) -> tuple[Mapping[str, object], Mapping[str, object]]:
    manifest = _load_yaml_mapping(relative_path)
    spec = cast(Mapping[str, object], manifest.get("spec", {}))
    job_template = cast(Mapping[str, object], spec.get("jobTemplate", {}))
    job_spec = cast(Mapping[str, object], job_template.get("spec", {}))
    template = cast(Mapping[str, object], job_spec.get("template", {}))
    pod_spec = cast(Mapping[str, object], template.get("spec", {}))
    containers = cast(list[Mapping[str, object]], pod_spec.get("containers", []))
    if not containers:
        raise AssertionError(f"{relative_path} missing job container")
    return spec, containers[0]


def _csv_symbols(value: object) -> list[str]:
    return [
        symbol.strip().upper()
        for symbol in str(value or "").split(",")
        if symbol.strip()
    ]


def _csv_values(value: object) -> set[str]:
    return {item.strip() for item in str(value or "").split(",") if item.strip()}


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
        f"{context} contains symbols outside the researched chip/AI infrastructure universe",
    )


def _assert_exact_chip_tech_universe(
    test_case: TestCase, symbols: Iterable[object], *, context: str
) -> None:
    normalized = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    _assert_chip_universe(test_case, normalized, context=context)
    test_case.assertEqual(
        tuple(normalized),
        _RESEARCHED_CHIP_TECH_UNIVERSE,
        f"{context} does not match the researched chip/AI infrastructure universe",
    )


def _assert_exact_live_execution_chip_universe(
    test_case: TestCase, symbols: Iterable[object], *, context: str
) -> None:
    normalized = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    _assert_chip_universe(test_case, normalized, context=context)
    test_case.assertEqual(
        tuple(normalized),
        _LIVE_EXECUTION_CHIP_TECH_UNIVERSE,
        f"{context} does not match the live executable chip core",
    )


def _assert_exact_quote_covered_paper_strategy_universe(
    test_case: TestCase, symbols: Iterable[object], *, context: str
) -> None:
    normalized = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    _assert_chip_universe(test_case, normalized, context=context)
    test_case.assertEqual(
        tuple(normalized),
        _QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE,
        f"{context} does not match the quote-covered paper strategy core",
    )


class TestLiveConfigManifestContract(TestCase):
    def test_knative_env_wiring_is_safe_live_defaults(self) -> None:
        env = _load_torghut_knative_env()
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_universe_source, "static")
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
        self.assertFalse(settings.trading_universe_require_non_empty_jangar)
        self.assertFalse(settings.trading_universe_static_fallback_enabled)
        self.assertEqual(settings.trading_universe_max_stale_seconds, 900)
        self.assertIsNone(settings.trading_jangar_symbols_url)
        self.assertEqual(
            settings.trading_jangar_control_plane_status_url,
            "http://agents.agents.svc.cluster.local/ready",
        )
        self.assertIsNone(settings.trading_jangar_quant_health_url)
        self.assertEqual(
            settings.trading_market_context_url,
            "http://jangar.jangar.svc.cluster.local/api/torghut/market-context",
        )
        self.assertEqual(
            set(settings.trading_static_symbols),
            set(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertFalse(settings.trading_market_context_required)
        self.assertEqual(settings.trading_market_context_fail_mode, "shadow_only")
        self.assertEqual(
            set(settings.trading_universe_static_fallback_symbols),
            set(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertNotIn("TRADING_FEATURE_FLAGS_URL", env)
        self.assertNotIn("TRADING_FORECAST_SERVICE_URL", env)
        self.assertNotIn("TRADING_LEAN_RUNNER_URL", env)
        self.assertNotIn("JANGAR_SYMBOLS_URL", env)
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL"),
            settings.trading_jangar_control_plane_status_url,
        )
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS", env)
        self.assertEqual(env.get("TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS"), "30")
        self.assertEqual(settings.trading_jangar_control_plane_timeout_seconds, 30)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_REQUIRED", env)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_URL", env)
        self.assertEqual(
            env.get("TRADING_MARKET_CONTEXT_URL"), settings.trading_market_context_url
        )
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_TIMEOUT_SECONDS"), "5")
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_REQUIRED"), "false")
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_FAIL_MODE"), "shadow_only")
        self.assertNotIn("JANGAR_BASE_URL", env)

    def test_live_manifest_limits_jangar_trading_loop_urls(self) -> None:
        env = _load_torghut_knative_env()

        blocked_env = {
            "JANGAR_SYMBOLS_URL",
            "TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS",
            "TRADING_JANGAR_QUANT_HEALTH_REQUIRED",
            "TRADING_JANGAR_QUANT_HEALTH_URL",
        }
        self.assertTrue(blocked_env.isdisjoint(env))
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL"),
            "http://agents.agents.svc.cluster.local/ready",
        )
        self.assertEqual(env.get("TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS"), "30")
        self.assertEqual(
            env.get("TRADING_MARKET_CONTEXT_URL"),
            "http://jangar.jangar.svc.cluster.local/api/torghut/market-context",
        )

    def test_strategy_catalog_universes_are_chip_only(self) -> None:
        for strategy in _load_torghut_strategy_catalog():
            raw_symbols = strategy.get("universe_symbols")
            self.assertIsInstance(
                raw_symbols,
                list,
                f"{strategy.get('name')} missing explicit universe_symbols",
            )
            _assert_chip_universe(
                self,
                cast(list[object], raw_symbols),
                context=f"strategy {strategy.get('name')}",
            )

    def test_enabled_paper_sleeves_are_chip_universe_with_safe_profiles(self) -> None:
        strategies = _load_torghut_strategy_catalog()
        enabled = {
            str(strategy.get("name")): strategy
            for strategy in strategies
            if _manifest_bool(strategy, "enabled")
        }
        self.assertEqual(
            set(enabled),
            {
                "microbar-volume-continuation-long-top2-chip-v1",
                "microbar-prev-day-open45-reversal-long-top1-chip-v1",
                "intraday-tsmom-profit-v3",
                "breakout-continuation-long-v1",
                "mean-reversion-rebound-long-v1",
                "mean-reversion-exhaustion-short-v1",
                "washout-rebound-long-v1",
                "late-day-continuation-long-v1",
            },
        )

        for name, strategy in enabled.items():
            description = str(strategy.get("description") or "").lower()
            params = _params(strategy)
            raw_symbols = strategy.get("universe_symbols")

            self.assertIn("paper-only", description)
            self.assertIsInstance(raw_symbols, list)
            if name == "intraday-tsmom-profit-v3":
                self.assertIn("$500/day", description)
                _assert_exact_live_execution_chip_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{name} universe",
                )
            else:
                self.assertIn("$300/day", description)
                _assert_exact_quote_covered_paper_strategy_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{name} universe",
                )
            if str(strategy.get("strategy_type")) == "microbar_cross_sectional_long_v1":
                self.assertEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade"),
                    Decimal("50000"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("2.0"),
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif str(strategy.get("strategy_type")) == "intraday_tsmom_v1":
                self.assertEqual(name, "intraday-tsmom-profit-v3")
                self.assertEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade"),
                    Decimal("3750"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("0.125"),
                )
                self.assertEqual(params.get("max_spread_bps"), "20")
                self.assertEqual(params.get("long_stop_loss_bps"), "6")
                self.assertEqual(params.get("short_stop_loss_bps"), "6")
                self.assertEqual(params.get("entry_cooldown_seconds"), "1200")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif str(strategy.get("strategy_type")) == "breakout_continuation_long_v1":
                self.assertEqual(name, "breakout-continuation-long-v1")
                self.assertEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade"),
                    Decimal("50000"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("3.0"),
                )
                self.assertEqual(params.get("max_spread_bps"), "20")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif str(strategy.get("strategy_type")) in {
                "mean_reversion_rebound_long_v1",
                "mean_reversion_exhaustion_short_v1",
            }:
                self.assertIn(
                    name,
                    {
                        "mean-reversion-rebound-long-v1",
                        "mean-reversion-exhaustion-short-v1",
                    },
                )
                self.assertLessEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade")
                    or Decimal("0"),
                    Decimal("31590"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("1.0"),
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("20"),
                )
            elif str(strategy.get("strategy_type")) == "washout_rebound_long_v1":
                self.assertEqual(name, "washout-rebound-long-v1")
                self.assertLessEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade")
                    or Decimal("0"),
                    Decimal("63180"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("2.0"),
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("20"),
                )
            elif str(strategy.get("strategy_type")) == "late_day_continuation_long_v1":
                self.assertEqual(name, "late-day-continuation-long-v1")
                self.assertLessEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade")
                    or Decimal("0"),
                    Decimal("94770"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("3.0"),
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("22"),
                )
            else:
                self.fail(
                    f"enabled paper strategy {name} has unexpected type {strategy.get('strategy_type')}"
                )

    def test_runtime_symbol_sources_use_live_signal_universe(self) -> None:
        live_env = _load_torghut_knative_env()
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        ws_config = _load_yaml_mapping("argocd/applications/torghut/ws/configmap.yaml")
        ws_data = ws_config.get("data")
        self.assertIsInstance(ws_data, Mapping)
        ws_metadata = ws_config.get("metadata")
        self.assertIsInstance(ws_metadata, Mapping)
        ws_annotations = cast(Mapping[str, object], ws_metadata).get("annotations")
        self.assertIsInstance(ws_annotations, Mapping)

        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(live_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="live static fallback symbols",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(live_env.get("TRADING_UNIVERSE_SYMBOL_ALLOWLIST")),
            context="live runtime universe allowlist",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="sim static fallback symbols",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(sim_env.get("TRADING_UNIVERSE_SYMBOL_ALLOWLIST")),
            context="sim runtime universe allowlist",
        )
        _assert_exact_live_execution_chip_universe(
            self,
            _csv_symbols(cast(Mapping[str, object], ws_data).get("SYMBOLS")),
            context="torghut-ws subscription symbols",
        )
        _assert_exact_live_execution_chip_universe(
            self,
            _csv_symbols(cast(Mapping[str, object], ws_data).get("SYMBOLS_ALLOWLIST")),
            context="torghut-ws subscription allowlist",
        )
        self.assertNotIn("JANGAR_SYMBOLS_URL", ws_data)
        self.assertEqual(
            cast(Mapping[str, object], ws_annotations).get(
                "argocd.argoproj.io/sync-options"
            ),
            "Replace=true",
        )

    def test_sim_manifest_runs_paper_live_signal_profile(self) -> None:
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )

        self.assertTrue(_manifest_bool(sim_env, "TRADING_ENABLED"))
        self.assertEqual(sim_env.get("TRADING_MODE"), "paper")
        self.assertEqual(sim_env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertTrue(_manifest_bool(sim_env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertTrue(
            _manifest_bool(sim_env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED")
        )
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            "25",
        )
        self.assertFalse(_manifest_bool(sim_env, "TRADING_SIMULATION_ENABLED"))
        self.assertEqual(sim_env.get("TRADING_UNIVERSE_SOURCE"), "static")
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR"), "false"
        )
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED"), "false"
        )
        self.assertEqual(
            sim_env.get("TRADING_STATIC_SYMBOLS"),
            "AAPL,AMZN,INTC,NVDA",
        )
        self.assertEqual(sim_env.get("CLICKHOUSE_DATABASE"), "torghut")
        self.assertEqual(sim_env.get("TRADING_SIGNAL_TABLE"), "torghut.ta_signals")
        self.assertEqual(sim_env.get("TRADING_PRICE_TABLE"), "torghut.ta_microbars")
        self.assertEqual(
            sim_env.get("TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS"),
            "300",
        )
        self.assertEqual(
            sim_env.get("TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS"),
            "60",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"),
            "true",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FEED"),
            "iex",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"),
            "20",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS"
            ),
            "60",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS"),
            "0",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"),
            "false",
        )
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS"),
            "AAPL,AMZN,INTC,NVDA",
        )
        self.assertNotIn("JANGAR_SYMBOLS_URL", sim_env)
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL", sim_env)
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS", sim_env)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_URL", sim_env)
        self.assertNotIn("TRADING_MARKET_CONTEXT_URL", sim_env)
        self.assertNotIn("JANGAR_BASE_URL", sim_env)
        self.assertNotIn("JANGAR_API_KEY", sim_env)
        self.assertFalse(
            any(key.startswith("TRADING_MARKET_CONTEXT_") for key in sim_env),
            "paper live-signal service must not import external market-context wiring",
        )
        self.assertEqual(
            _csv_values(sim_env.get("TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS")),
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )
        self.assertNotIn(
            "no_signals_in_window",
            _csv_values(sim_env.get("TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS")),
        )

    def test_autonomy_config_does_not_treat_normal_no_signal_as_critical(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/autonomy-configmap.yaml"
        )
        data = manifest.get("data")
        self.assertIsInstance(data, Mapping)

        critical_reasons = _csv_values(
            cast(Mapping[str, object], data).get(
                "TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS"
            )
        )
        self.assertEqual(
            critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )

    def test_clickhouse_replicas_are_not_pinned_to_single_architecture(self) -> None:
        manifest = _load_torghut_clickhouse_manifest()
        pod_templates = (
            manifest.get("spec", {}).get("templates", {}).get("podTemplates", [])
        )
        self.assertTrue(pod_templates)
        for template in pod_templates:
            self.assertIsInstance(template, Mapping)
            spec = cast(Mapping[str, object], template).get("spec")
            self.assertIsInstance(spec, Mapping)
            node_selector = cast(Mapping[str, object], spec).get("nodeSelector")
            self.assertNotEqual(
                node_selector,
                {"kubernetes.io/arch": "arm64"},
                f"{template.get('name')} pins ClickHouse to one architecture",
            )

    def test_whitepaper_semantic_backfill_runs_on_arm_nodes(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/whitepaper-semantic-backfill-job.yaml"
        )
        pod_spec = manifest.get("spec", {}).get("template", {}).get("spec", {})
        self.assertIsInstance(pod_spec, Mapping)
        self.assertEqual(
            cast(Mapping[str, object], pod_spec).get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )

    def test_execution_tca_refresh_cronjob_keeps_readiness_evidence_fresh(
        self,
    ) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/execution-tca-refresh-cronjob.yaml"
        )
        spec = cast(Mapping[str, object], manifest.get("spec", {}))
        job_template = cast(Mapping[str, object], spec.get("jobTemplate", {}))
        job_spec = cast(Mapping[str, object], job_template.get("spec", {}))
        template = cast(Mapping[str, object], job_spec.get("template", {}))
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        containers = cast(list[Mapping[str, object]], pod_spec.get("containers", []))

        self.assertEqual(spec.get("schedule"), "*/5 * * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 240)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        self.assertTrue(containers)

        container = containers[0]
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )
        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            value_from.get("secretKeyRef"),
            {"name": "torghut-db-app", "key": "uri"},
        )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/refresh_execution_tca_metrics.py", args)
        self.assertIn("--older-than-seconds 900", args)
        self.assertIn("--batch-size 250", args)
        self.assertIn("--max-batches 1", args)
        self.assertIn("--apply", args)

    def test_empirical_promotion_renewal_imports_paper_windows_from_sim_db(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "23 8,20 * * *")
        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        db_value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            db_value_from.get("secretKeyRef"),
            {"name": "torghut-db-app", "key": "uri"},
        )
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        for name, key in {
            "TORGHUT_SIM_DB_HOST": "host",
            "TORGHUT_SIM_DB_PORT": "port",
            "TORGHUT_SIM_DB_USER": "username",
            "TORGHUT_SIM_DB_PASSWORD": "password",
        }.items():
            value_from = cast(Mapping[str, object], env[name].get("valueFrom", {}))
            self.assertEqual(
                value_from.get("secretKeyRef"),
                {"name": "torghut-db-app", "key": key},
            )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/renew_latest_empirical_promotion_jobs.py", args)
        self.assertIn("--runtime-window-hypothesis-id H-TSMOM-01", args)
        self.assertIn(
            "--runtime-window-target hypothesis_id=H-TSMOM-01,"
            "candidate_id=spec-83161ae16d17828eabcc58cc,"
            "strategy_family=intraday_tsmom_consistent,"
            "strategy_name=intraday-tsmom-profit-v3,"
            "source_manifest_ref=config/trading/hypotheses/h-tsmom-01.json",
            args,
        )
        self.assertIn(
            "--runtime-window-target hypothesis_id=H-PAIRS-01,"
            "candidate_id=spec-d74b07b2aaab8d0cfa8a4c38,"
            "strategy_family=microbar_cross_sectional_pairs,"
            "strategy_name=microbar-cross-sectional-pairs-v1,"
            "source_manifest_ref=config/trading/hypotheses/h-pairs-01.json",
            args,
        )
        self.assertIn("--runtime-window-account-label TORGHUT_SIM", args)
        self.assertIn("--runtime-window-observed-stage paper", args)
        self.assertIn("--runtime-window-source-dsn-env SIM_DB_DSN", args)
        self.assertNotIn("--runtime-window-source-dsn-env DB_DSN", args)

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
        env = [item for item in container.get("env", []) if isinstance(item, Mapping)]
        upgrade_to_research_objects = (
            'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini '
            "upgrade 0026_strategy_factory_research_objects"
        )
        upgrade_heads = 'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini upgrade heads'
        env_names = {item.get("name") for item in env}
        env_by_name = {item.get("name"): item for item in env}
        env_order = [item.get("name") for item in env]

        self.assertIn("TORGHUT_POSTGRES_ADMIN_URI", env_names)
        self.assertIn("TORGHUT_SIM_ADMIN_DSN", env_names)
        self.assertLess(
            env_order.index("TORGHUT_SIM_ADMIN_DB_PASSWORD"),
            env_order.index("TORGHUT_POSTGRES_ADMIN_URI"),
        )
        self.assertEqual(
            env_by_name["TORGHUT_POSTGRES_ADMIN_URI"].get("value"),
            "postgresql://$(TORGHUT_SIM_ADMIN_DB_USER):$(TORGHUT_SIM_ADMIN_DB_PASSWORD)@"
            "$(TORGHUT_SIM_ADMIN_DB_HOST):$(TORGHUT_SIM_ADMIN_DB_PORT)/postgres",
        )
        self.assertNotIn("valueFrom", env_by_name["TORGHUT_POSTGRES_ADMIN_URI"])
        self.assertIn("database_url(admin_uri, 'postgres')", args)
        self.assertIn("CREATE DATABASE", args)
        self.assertIn("GRANT ALL PRIVILEGES ON DATABASE", args)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS vector", args)
        self.assertIn("postgresql+psycopg://", args)
        self.assertIn("select quote_ident(:role_name)", args)
        self.assertIn("c.oid::regclass::text AS object_name", args)
        self.assertIn("pg_get_userbyid(c.relowner) <> :runtime_role", args)
        self.assertIn("owner_statement = (", args)
        self.assertIn("ALTER {owned_relation['object_type']}", args)
        self.assertIn("{owned_relation['object_name']} OWNER TO {quoted_role}", args)
        self.assertNotIn("DO $$", args)
        self.assertNotIn("format(", args)
        self.assertIn(upgrade_to_research_objects, args)
        self.assertIn("0028_autoresearch_epoch_ledgers", args)
        self.assertIn("whitepaper_claims", args)
        self.assertIn("autoresearch_portfolio_candidates", args)
        self.assertIn("public_table_exists", args)
        self.assertIn(upgrade_heads, args)
        self.assertIn("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public", args)
        self.assertIn("granted simulation runtime privileges", args)
        self.assertLess(
            args.index("CREATE EXTENSION IF NOT EXISTS vector"),
            args.index("c.oid::regclass::text AS object_name"),
        )
        self.assertLess(
            args.index("owner_statement = ("),
            args.index(upgrade_to_research_objects),
        )
        self.assertLess(
            args.index(upgrade_to_research_objects),
            args.index("stamped existing whitepaper/autoresearch ledger objects"),
        )
        self.assertLess(
            args.index("stamped existing whitepaper/autoresearch ledger objects"),
            args.index(upgrade_heads),
        )
        self.assertLess(
            args.index(upgrade_heads),
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
                _assert_exact_live_execution_chip_universe(
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
            _assert_exact_live_execution_chip_universe(
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
        self.assertEqual(env.get("TRADING_UNIVERSE_SOURCE"), "static")
        self.assertEqual(env.get("TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR"), "false")
        self.assertEqual(env.get("TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED"), "false")
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            str(env.get("TRADING_STATIC_SYMBOLS", "")).split(","),
            context="live static universe",
        )
        self.assertFalse(_manifest_bool(env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertFalse(
            _manifest_bool(env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED")
        )
        self.assertFalse(_manifest_bool(env, "TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"))
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

    def test_profit_claim_strategies_require_executable_live_proof(self) -> None:
        strategies = _load_torghut_strategy_catalog()
        proof_claim_strategies: list[dict[str, object]] = []
        for strategy in strategies:
            description = str(strategy.get("description") or "").lower()
            strategy_id = str(strategy.get("strategy_id") or "").lower()
            if (
                "strict-daily-profit" in description
                or "promoted" in description
                or strategy_id.endswith("@prod")
            ):
                proof_claim_strategies.append(strategy)
        self.assertTrue(proof_claim_strategies)

        for strategy in proof_claim_strategies:
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
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no executable evidence ref",
            )
            self.assertGreaterEqual(
                Decimal(str(target_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no $300/day target proof",
            )
            self.assertGreaterEqual(
                Decimal(str(min_daily_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no every-day $300 proof",
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

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
            env[name] = (
                raw_value
                if isinstance(raw_value, str)
                else ""
                if raw_value is None
                else str(raw_value)
            )
        elif "valueFrom" not in item:
            env[name] = ""
    return env


def _load_knative_template_spec(relative_path: str) -> Mapping[str, object]:
    manifest = _load_yaml_mapping(relative_path)
    return cast(
        Mapping[str, object],
        manifest.get("spec", {}).get("template", {}).get("spec", {}),
    )


def _load_knative_container(relative_path: str) -> Mapping[str, object]:
    template_spec = _load_knative_template_spec(relative_path)
    containers = cast(list[Mapping[str, object]], template_spec.get("containers", []))
    if not containers:
        raise AssertionError(f"{relative_path} missing spec.template.spec.containers")
    return containers[0]


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


def _load_job_container(
    relative_path: str,
) -> tuple[Mapping[str, object], Mapping[str, object]]:
    manifest = _load_yaml_mapping(relative_path)
    spec = cast(Mapping[str, object], manifest.get("spec", {}))
    template = cast(Mapping[str, object], spec.get("template", {}))
    pod_spec = cast(Mapping[str, object], template.get("spec", {}))
    containers = cast(list[Mapping[str, object]], pod_spec.get("containers", []))
    if not containers:
        raise AssertionError(f"{relative_path} missing job container")
    return spec, containers[0]


def _container_env(container: Mapping[str, object]) -> dict[str, object]:
    env_entries = cast(list[Mapping[str, object]], container.get("env", []))
    env: dict[str, object] = {}
    for item in env_entries:
        name = item.get("name")
        if isinstance(name, str) and "value" in item:
            env[name] = item["value"]
    return env


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
        self.assertEqual(
            env.get("AGENTS_BASE_URL"), "http://agents.agents.svc.cluster.local"
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
                "microbar-cross-sectional-pairs-v1",
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
            elif name == "microbar-cross-sectional-pairs-v1":
                self.assertIn("h-pairs", description)
                self.assertEqual(
                    tuple(str(symbol) for symbol in cast(list[object], raw_symbols)),
                    ("AAPL", "AMZN"),
                    f"{name} must stay aligned to the active H-PAIRS candidate pair",
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
            elif (
                str(strategy.get("strategy_type"))
                == "microbar_cross_sectional_pairs_v1"
            ):
                self.assertEqual(name, "microbar-cross-sectional-pairs-v1")
                self.assertEqual(
                    _strategy_decimal(strategy, "max_notional_per_trade"),
                    Decimal("75000"),
                )
                self.assertEqual(
                    _strategy_decimal(strategy, "max_position_pct_equity"),
                    Decimal("6.0"),
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertEqual(params.get("max_gross_exposure_pct_equity"), "4.0")
                self.assertEqual(params.get("max_pair_legs"), "2")
                self.assertEqual(params.get("top_n"), "1")
                self.assertEqual(
                    params.get("min_cross_section_continuation_rank"), "0.55"
                )
                self.assertEqual(params.get("entry_minute_after_open"), "60")
                self.assertEqual(params.get("exit_minute_after_open"), "120")
                self.assertEqual(params.get("session_flatten_start_minute_utc"), "1170")
                self.assertEqual(params.get("long_stop_loss_bps"), "10")
                self.assertEqual(
                    params.get("long_trailing_stop_activation_profit_bps"), "8"
                )
                self.assertEqual(params.get("long_trailing_stop_drawdown_bps"), "4")
                self.assertEqual(params.get("max_hold_seconds"), "7200")
                self.assertEqual(params.get("max_session_negative_exit_bps"), "10")
                self.assertEqual(params.get("max_stop_loss_exits_per_session"), "1")
                self.assertEqual(params.get("stop_loss_lockout_seconds"), "1800")
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
        live_env = _load_torghut_knative_env()

        self.assertTrue(_manifest_bool(sim_env, "TRADING_ENABLED"))
        self.assertEqual(sim_env.get("TRADING_MODE"), "paper")
        self.assertEqual(sim_env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertTrue(_manifest_bool(sim_env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertTrue(_manifest_bool(sim_env, "TRADING_ORDER_FEED_ENABLED"))
        self.assertTrue(
            _manifest_bool(sim_env, "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED"),
            "paper-route proof cannot materialize execution_order_events without simple order-feed telemetry",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_TOPIC"),
            "torghut.trade-updates.v1",
            "live-paper proof must consume the broker trade-update topic, not the simulation topic",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_ASSIGNMENT_MODE"),
            "manual",
            "sim proof ingestion must avoid unstable Kafka group rebalances and resume from DB offsets",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_AUTO_OFFSET_RESET"),
            "earliest",
            "first rollout must backfill existing broker order events for proof materialization",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_TOPIC_V2"),
            "",
            "v2 broker envelopes carry the producer account label and can prevent TORGHUT_SIM linkage",
        )
        self.assertTrue(
            _manifest_bool(sim_env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED")
        )
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            "75000",
        )
        self.assertEqual(
            sim_env.get("TRADING_PAPER_ROUTE_TARGET_PLAN_URL"),
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan",
        )
        self.assertEqual(
            sim_env.get("TRADING_PAPER_ROUTE_TARGET_PLAN_TIMEOUT_SECONDS"),
            "10",
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
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED"),
            "true",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"),
            "60",
        )
        self.assertEqual(
            sim_env.get("TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"),
            "30",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS"
            ),
            "300",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS"),
            "60",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"),
            "true",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_FEED"),
            "iex",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"),
            "20",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED"
            ),
            "true",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"
            ),
            "60",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"
            ),
            "30",
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
        self.assertEqual(
            sim_env.get("AGENTS_BASE_URL"), "http://agents.agents.svc.cluster.local"
        )
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

        self.assertEqual(live_env.get("TRADING_MODE"), "live")
        self.assertFalse(_manifest_bool(live_env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertTrue(
            _manifest_bool(live_env, "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED"),
            "live proof floor requires lifecycle telemetry even while submit stays disabled",
        )
        self.assertTrue(_manifest_bool(live_env, "TRADING_ORDER_FEED_ENABLED"))
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_TOPIC"),
            "",
            "live telemetry should consume account-labelled v2 envelopes only",
        )
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_TOPIC_V2"), "torghut.trade-updates.v2"
        )
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_GROUP_ID"),
            "torghut-order-feed-live-default",
        )
        self.assertEqual(live_env.get("TRADING_ORDER_FEED_ASSIGNMENT_MODE"), "manual")
        self.assertEqual(live_env.get("TRADING_ORDER_FEED_AUTO_OFFSET_RESET"), "latest")

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

    def test_torghut_declares_tigerbeetle_cluster(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/tigerbeetle-cluster.yaml"
        )

        self.assertEqual(manifest["apiVersion"], "tigerbeetle.proompteng.ai/v1alpha1")
        self.assertEqual(manifest["kind"], "TigerBeetleCluster")
        self.assertEqual(
            manifest["metadata"],
            {
                "name": "torghut-tigerbeetle",
                "namespace": "torghut",
                "labels": {
                    "app.kubernetes.io/name": "torghut-tigerbeetle",
                    "app.kubernetes.io/part-of": "torghut",
                },
            },
        )
        spec = manifest["spec"]
        self.assertIsInstance(spec, Mapping)
        spec_mapping = cast(Mapping[str, object], spec)
        self.assertEqual(spec_mapping["clusterID"], "2001")
        self.assertEqual(spec_mapping["replicas"], 1)
        self.assertEqual(
            spec_mapping["image"],
            {
                "repository": "ghcr.io/tigerbeetle/tigerbeetle",
                "tag": "0.17.4",
                "pullPolicy": "IfNotPresent",
            },
        )
        self.assertEqual(
            spec_mapping["storage"], {"className": "rook-ceph-block", "size": "100Gi"}
        )
        self.assertEqual(spec_mapping["nodeSelector"], {"kubernetes.io/arch": "arm64"})
        self.assertEqual(spec_mapping["pdb"], {"enabled": True, "minAvailable": 1})
        self.assertEqual(spec_mapping["health"], {"checkIntervalSeconds": 5})

    def test_torghut_kustomization_includes_tigerbeetle_cluster(self) -> None:
        manifest = _load_yaml_mapping("argocd/applications/torghut/kustomization.yaml")
        resources = manifest.get("resources")

        self.assertIsInstance(resources, list)
        self.assertIn("tigerbeetle-cluster.yaml", resources)
        self.assertIn("tigerbeetle-smoke-job.yaml", resources)
        self.assertIn("tigerbeetle-journal-order-events-cronjob.yaml", resources)

    def test_torghut_knative_manifests_enable_tigerbeetle_journal(self) -> None:
        expected = {
            "TORGHUT_TIGERBEETLE_ENABLED": "true",
            "TORGHUT_TIGERBEETLE_REQUIRED": "false",
            "TORGHUT_TIGERBEETLE_CLUSTER_ID": "2001",
            "TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES": "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
            "TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS": "5",
            "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
            "TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED": "false",
        }
        for relative_path in (
            "argocd/applications/torghut/knative-service.yaml",
            "argocd/applications/torghut/knative-service-sim.yaml",
        ):
            env = _load_knative_env(relative_path)
            for key, value in expected.items():
                self.assertEqual(env.get(key), value, f"{relative_path} {key}")

    def test_torghut_tigerbeetle_client_pods_allow_io_uring(self) -> None:
        for relative_path in (
            "argocd/applications/torghut/knative-service.yaml",
            "argocd/applications/torghut/knative-service-sim.yaml",
        ):
            container = _load_knative_container(relative_path)
            security_context = cast(
                Mapping[str, object],
                container.get("securityContext", {}),
            )
            seccomp_profile = cast(
                Mapping[str, object],
                security_context.get("seccompProfile", {}),
            )
            self.assertEqual(
                seccomp_profile.get("type"),
                "Unconfined",
                f"{relative_path} official TigerBeetle client requires io_uring",
            )

        _, smoke_container = _load_job_container(
            "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"
        )
        smoke_security_context = cast(
            Mapping[str, object],
            smoke_container.get("securityContext", {}),
        )
        smoke_seccomp_profile = cast(
            Mapping[str, object],
            smoke_security_context.get("seccompProfile", {}),
        )
        self.assertEqual(smoke_seccomp_profile.get("type"), "Unconfined")

    def test_torghut_tigerbeetle_smoke_job_runs_protocol_proof(self) -> None:
        spec, container = _load_job_container(
            "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"
        )
        env = _container_env(container)

        self.assertEqual(spec.get("backoffLimit"), 3)
        self.assertEqual(spec.get("activeDeadlineSeconds"), 300)
        self.assertRegex(
            container.get("image", ""),
            r"^registry\.ide-newton\.ts\.net/lab/torghut@sha256:[0-9a-f]{64}$",
        )
        self.assertEqual(
            container.get("command"),
            ["/bin/bash", "-lc"],
        )
        args = container.get("args")
        self.assertIsInstance(args, list)
        self.assertIn("scripts/verify_tigerbeetle_ledger.py --mode smoke", str(args[0]))
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_ENABLED"), "true")
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_REQUIRED"), "true")
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_CLUSTER_ID"), "2001")
        self.assertEqual(
            env.get("TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES"),
            "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
        )

    def test_product_applicationset_renders_torghut_namespace_security_metadata(
        self,
    ) -> None:
        manifest = _load_yaml_mapping("argocd/applicationsets/product.yaml")
        elements = (
            manifest.get("spec", {})
            .get("generators", [])[0]
            .get("matrix", {})
            .get("generators", [])[1]
            .get("list", {})
            .get("elements", [])
        )
        torghut = next(
            item
            for item in elements
            if isinstance(item, Mapping) and item.get("name") == "torghut"
        )
        managed_namespace_metadata = cast(
            Mapping[str, object], torghut.get("managedNamespaceMetadata", {})
        )

        self.assertEqual(
            managed_namespace_metadata.get("labels"),
            {
                "pod-security.kubernetes.io/enforce": "privileged",
                "pod-security.kubernetes.io/audit": "privileged",
                "pod-security.kubernetes.io/warn": "privileged",
            },
        )
        self.assertEqual(
            managed_namespace_metadata.get("annotations"),
            {"argocd.argoproj.io/sync-options": "Prune=false"},
        )
        self.assertIn(
            "managedNamespaceMetadata",
            str(manifest.get("spec", {}).get("templatePatch", "")),
        )

    def test_production_ta_clickhouse_sink_uses_batched_inserts(self) -> None:
        manifest = _load_yaml_mapping("argocd/applications/torghut/ta/configmap.yaml")
        data = manifest.get("data")
        self.assertIsInstance(data, Mapping)

        self.assertGreaterEqual(
            int(str(cast(Mapping[str, object], data).get("TA_CLICKHOUSE_BATCH_SIZE"))),
            1000,
        )
        self.assertGreaterEqual(
            int(str(cast(Mapping[str, object], data).get("TA_CLICKHOUSE_FLUSH_MS"))),
            5000,
        )
        self.assertEqual(
            cast(Mapping[str, object], data).get("TA_CLICKHOUSE_SINK_PARALLELISM"),
            "1",
        )

    def test_options_ta_uses_primary_clickhouse_auth_secret(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut-options/ta/flinkdeployment.yaml"
        )
        pod_template = cast(Mapping[str, object], manifest.get("spec", {})).get(
            "podTemplate"
        )
        self.assertIsInstance(pod_template, Mapping)
        pod_spec = cast(Mapping[str, object], pod_template).get("spec")
        self.assertIsInstance(pod_spec, Mapping)
        containers = cast(Mapping[str, object], pod_spec).get("containers")
        self.assertIsInstance(containers, list)
        self.assertTrue(containers)

        env = {
            item.get("name"): item
            for item in cast(
                list[Mapping[str, object]],
                cast(Mapping[str, object], containers[0]).get("env", []),
            )
        }
        clickhouse_password = cast(Mapping[str, object], env["TA_CLICKHOUSE_PASSWORD"])
        value_from = cast(
            Mapping[str, object], clickhouse_password.get("valueFrom", {})
        )
        self.assertEqual(
            value_from.get("secretKeyRef"),
            {"name": "torghut-clickhouse-auth", "key": "torghut_password"},
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

    def test_paper_account_flatten_cronjob_can_clean_dirty_paper_proof_account(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/paper-account-flatten-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "5,20,25 9 * * 1-5")
        self.assertEqual(spec.get("timeZone"), "America/New_York")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 300)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "50m",
                    "memory": "128Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "250m",
                    "memory": "256Mi",
                    "ephemeral-storage": "512Mi",
                },
            },
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
        self.assertEqual(env["TRADING_MODE"].get("value"), "paper")
        self.assertEqual(env["TRADING_ACCOUNT_LABEL"].get("value"), "TORGHUT_SIM")
        self.assertEqual(env["TRADING_KILL_SWITCH_ENABLED"].get("value"), "false")

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/flatten_paper_account_positions.py", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--expected-account-label TORGHUT_SIM", args)
        self.assertIn("--trading-mode paper", args)
        self.assertIn("--paper-base-url https://paper-api.alpaca.markets", args)
        self.assertIn("--max-gross-market-value 100000", args)
        self.assertNotIn("--max-gross-market-value 2500", args)
        self.assertIn("--max-position-count 25", args)
        self.assertIn("--extended-hours-limit", args)
        self.assertIn("--limit-away-bps 200", args)
        self.assertIn("--wait-flat-seconds 120", args)
        self.assertIn("--poll-seconds 10", args)
        self.assertIn("--persist-snapshot", args)
        self.assertIn("--apply", args)
        self.assertIn("--json", args)

    def test_order_feed_source_window_repair_cronjob_is_bounded_sim_only(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "13,28,43,58 * * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 300)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 180)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "50m",
                    "memory": "128Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "250m",
                    "memory": "256Mi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )

        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        self.assertNotIn("DB_DSN", env)
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
        self.assertIn("scripts/repair_order_feed_source_windows.py", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 500", args)
        self.assertIn("--max-batches 1", args)
        self.assertIn("--apply", args)
        self.assertIn("scripts/journal_tigerbeetle_order_events.py", args)
        self.assertIn("--max-batches 2", args)
        self.assertIn("--reconcile-limit 1000", args)
        self.assertIn("--json", args)
        security_context = cast(
            Mapping[str, object],
            container.get("securityContext", {}),
        )
        seccomp_profile = cast(
            Mapping[str, object],
            security_context.get("seccompProfile", {}),
        )
        self.assertEqual(seccomp_profile.get("type"), "Unconfined")

    def test_tigerbeetle_journal_order_events_cronjob_is_independent_sim_only(
        self,
    ) -> None:
        relative_path = (
            "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml"
        )
        manifest = _load_yaml_mapping(relative_path)
        spec, container = _load_cronjob_container(relative_path)
        metadata = cast(Mapping[str, object], manifest.get("metadata", {}))

        self.assertEqual(
            metadata.get("name"),
            "torghut-tigerbeetle-journal-order-events",
        )
        self.assertEqual(spec.get("schedule"), "6,21,36,51 * * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 300)
        self.assertEqual(spec.get("successfulJobsHistoryLimit"), 2)
        self.assertEqual(spec.get("failedJobsHistoryLimit"), 3)

        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 600)
        self.assertEqual(job_spec.get("backoffLimit"), 1)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        self.assertEqual(
            container.get("command"),
            ["/bin/bash", "-lc"],
        )
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )

        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        self.assertNotIn("DB_DSN", env)
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

        value_env = _container_env(container)
        self.assertEqual(value_env["TORGHUT_TIGERBEETLE_ENABLED"], "true")
        self.assertEqual(value_env["TORGHUT_TIGERBEETLE_REQUIRED"], "false")
        self.assertEqual(value_env["TORGHUT_TIGERBEETLE_CLUSTER_ID"], "2001")
        self.assertEqual(
            value_env["TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES"],
            "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
        )
        self.assertEqual(value_env["TORGHUT_TIGERBEETLE_JOURNAL_ENABLED"], "true")
        self.assertEqual(
            value_env["TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED"],
            "false",
        )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/journal_tigerbeetle_order_events.py", args)
        self.assertNotIn("scripts/repair_order_feed_source_windows.py", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 500", args)
        self.assertIn("--max-batches 2", args)
        self.assertIn("--reconcile-limit 1000", args)
        self.assertIn("--fail-on-degraded", args)
        self.assertIn("--json", args)
        security_context = cast(
            Mapping[str, object],
            container.get("securityContext", {}),
        )
        seccomp_profile = cast(
            Mapping[str, object],
            security_context.get("seccompProfile", {}),
        )
        self.assertEqual(seccomp_profile.get("type"), "Unconfined")

    def test_empirical_promotion_renewal_imports_authoritative_sim_paper_plan_and_sim_db(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "23 8,21 * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 900)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 900)
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi",
                    "ephemeral-storage": "256Mi",
                },
                "limits": {
                    "cpu": "1",
                    "memory": "1Gi",
                    "ephemeral-storage": "2Gi",
                },
            },
        )
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
        self.assertIn("scripts/repair_order_feed_source_windows.py", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 1000", args)
        self.assertIn("--max-batches 2", args)
        self.assertIn("scripts/renew_latest_empirical_promotion_jobs.py", args)
        self.assertIn(
            "--runtime-window-target-plan-url "
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            args,
        )
        self.assertIn("--runtime-window-target-plan-url-timeout-seconds 45", args)
        self.assertIn("--runtime-window-target-plan-url-attempts 3", args)
        self.assertIn(
            "--runtime-window-target-plan-url-retry-backoff-seconds 5",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-evidence",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-evidence",
            args,
        )
        self.assertIn("--runtime-window-target-plan-exclusive", args)
        self.assertIn("--runtime-window-target-plan-required", args)
        self.assertIn("--runtime-window-target-plan-settlement-seconds 3600", args)
        self.assertIn("--runtime-window-targets-from-latest-autoresearch", args)
        self.assertIn("--runtime-window-targets-from-registry", args)
        self.assertIn(
            "--strategy-spec-ref microbar_cross_sectional_pairs_v1@research", args
        )
        self.assertIn("--runtime-window-hypothesis-id H-PAIRS-01", args)
        self.assertIn("--runtime-window-candidate-id c88421d619759b2cfaa6f4d0", args)
        self.assertIn(
            "--runtime-window-strategy-family microbar_cross_sectional_pairs", args
        )
        self.assertIn(
            "--runtime-window-strategy-name microbar-cross-sectional-pairs-v1", args
        )
        self.assertIn(
            "--runtime-window-source-manifest-ref config/trading/hypotheses/h-pairs-01.json",
            args,
        )
        self.assertNotIn("--runtime-window-hypothesis-id H-TSMOM-01", args)
        self.assertNotIn("--runtime-window-target hypothesis_id=", args)
        self.assertIn("--runtime-window-account-label TORGHUT_SIM", args)
        self.assertIn("--runtime-window-observed-stage paper", args)
        self.assertIn("--runtime-window-source-dsn-env SIM_DB_DSN", args)
        self.assertIn("--runtime-window-target-dsn-env SIM_DB_DSN", args)
        self.assertNotIn("--runtime-window-source-dsn-env DB_DSN", args)
        self.assertIn(
            "RENEWAL_OUTPUT=/tmp/torghut-empirical-renewal/runtime-window-renewal.json",
            args,
        )
        self.assertIn(
            "PROOF_PACKET_OUTPUT=/tmp/torghut-empirical-renewal/runtime-ledger-proof-packet.json",
            args,
        )
        self.assertIn(
            'mkdir -p "$(dirname "${RENEWAL_OUTPUT}")" "$(dirname "${PROOF_PACKET_OUTPUT}")"',
            args,
        )
        self.assertIn("scripts/assemble_runtime_ledger_proof_packet.py", args)
        self.assertIn(
            "--status-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn(
            "--paper-route-service-base-url http://torghut-sim.torghut.svc.cluster.local",
            args,
        )
        self.assertNotIn(
            "--paper-route-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn(
            "--completion-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn("--proof-mode authority", args)
        self.assertIn('--runtime-window-import-file "${RENEWAL_OUTPUT}"', args)
        self.assertIn("--min-runtime-ledger-net-pnl 10000", args)
        self.assertIn("--min-runtime-ledger-daily-net-pnl 500", args)
        self.assertIn("--min-runtime-ledger-trading-days 20", args)
        self.assertIn("--max-runtime-ledger-drawdown-pct-equity 0.03", args)
        self.assertIn("--max-runtime-ledger-best-day-share 0.25", args)
        self.assertIn("--max-runtime-ledger-symbol-concentration-share 0.35", args)
        self.assertIn('--output-file "${PROOF_PACKET_OUTPUT}"', args)
        self.assertIn(
            "--artifact-prefix 'runtime-ledger-proof-packets/{run_id}'",
            args,
        )
        self.assertIn("--require-artifact-upload", args)
        self.assertIn("--allow-blocked-exit-zero", args)

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

    def test_washout_profitability_frontier_requires_capital_safe_replay(
        self,
    ) -> None:
        payload = _load_yaml_mapping(
            "services/torghut/config/trading/profitability-frontier-consistent-washout.yaml"
        )
        consistency_constraints = payload.get("consistency_constraints")
        self.assertIsInstance(consistency_constraints, Mapping)
        constraints = cast(Mapping[str, object], consistency_constraints)

        self.assertIs(payload.get("disable_other_strategies"), True)
        self.assertLessEqual(
            Decimal(str(constraints.get("max_gross_exposure_pct_equity"))),
            Decimal("1.0"),
        )
        self.assertGreaterEqual(
            Decimal(str(constraints.get("min_cash"))),
            Decimal("0"),
        )

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
        self.assertTrue(_manifest_bool(env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED"))
        self.assertEqual(
            env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"), "75000"
        )
        self.assertTrue(_manifest_bool(env, "TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"))
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_FEED"), "iex")
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"), "20")
        self.assertTrue(
            _manifest_bool(env, "TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED")
        )
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"), "60")
        self.assertEqual(
            env.get("TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"), "30"
        )
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

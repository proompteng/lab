from __future__ import annotations


import json
from decimal import Decimal
from pathlib import Path
from typing import Iterable, Mapping, cast
from unittest import TestCase

from pydantic import ValidationError
from yaml import safe_load, safe_load_all

from app.config import Settings
from app.trading.llm.dspy_programs.runtime import DSPyReviewRuntime
from app.trading.tigerbeetle_journal import SOURCE_TYPE_EXECUTION_ORDER_EVENT
from scripts import run_tigerbeetle_journal_cron as tigerbeetle_journal_runner


_RESEARCHED_CHIP_TECH_UNIVERSE = (
    "NVDA",
    "AVGO",
    "AMD",
    "MU",
    "MRVL",
    "CRDO",
    "COHR",
    "LITE",
    "SNDK",
    "WDC",
)
_LIVE_EXECUTION_CHIP_TECH_UNIVERSE = _RESEARCHED_CHIP_TECH_UNIVERSE
_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE = _LIVE_EXECUTION_CHIP_TECH_UNIVERSE
_CHIP_UNIVERSE_SYMBOLS = set(_RESEARCHED_CHIP_TECH_UNIVERSE)
_LIVE_EXECUTION_CHIP_UNIVERSE_SYMBOLS = set(_LIVE_EXECUTION_CHIP_TECH_UNIVERSE)


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "argocd").is_dir() and (parent / "services" / "torghut").is_dir():
            return parent
    return Path(__file__).resolve().parents[4]


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


load_yaml_mapping = _load_yaml_mapping


def _load_yaml_mappings(relative_path: str) -> list[dict[str, object]]:
    manifest_path = _repo_root() / relative_path
    manifests: list[dict[str, object]] = []
    for manifest in safe_load_all(manifest_path.read_text(encoding="utf-8")):
        if not isinstance(manifest, dict):
            raise AssertionError(f"{relative_path} contained a non-mapping document")
        manifests.append(manifest)
    if not manifests:
        raise AssertionError(f"{relative_path} did not contain any YAML documents")
    return manifests


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


class _TestLiveConfigManifestContractBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "DSPyReviewRuntime",
    "Decimal",
    "Iterable",
    "Mapping",
    "Path",
    "SOURCE_TYPE_EXECUTION_ORDER_EVENT",
    "Settings",
    "TestCase",
    "ValidationError",
    "_CHIP_UNIVERSE_SYMBOLS",
    "_LIVE_EXECUTION_CHIP_TECH_UNIVERSE",
    "_LIVE_EXECUTION_CHIP_UNIVERSE_SYMBOLS",
    "_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE",
    "_RESEARCHED_CHIP_TECH_UNIVERSE",
    "_TestLiveConfigManifestContractBase",
    "_assert_chip_universe",
    "_assert_exact_chip_tech_universe",
    "_assert_exact_live_execution_chip_universe",
    "_assert_exact_quote_covered_paper_strategy_universe",
    "_container_env",
    "_csv_symbols",
    "_csv_values",
    "_load_cronjob_container",
    "_load_job_container",
    "_load_knative_container",
    "_load_knative_env",
    "_load_knative_template_spec",
    "_load_torghut_clickhouse_manifest",
    "_load_torghut_feature_flags",
    "_load_torghut_knative_env",
    "_load_torghut_knative_manifest",
    "_load_torghut_strategy_catalog",
    "_load_yaml_mapping",
    "_load_yaml_mappings",
    "_manifest_bool",
    "_params",
    "_repo_root",
    "_strategy_decimal",
    "cast",
    "json",
    "load_yaml_mapping",
    "safe_load",
    "safe_load_all",
    "tigerbeetle_journal_runner",
)

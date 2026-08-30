from __future__ import annotations

from decimal import Decimal
from typing import Mapping, cast

from yaml import safe_load

from app.config import Settings
from app.trading.economic_policy import (
    DEFAULT_ECONOMIC_POLICY_PATH,
    load_economic_policy,
    load_runtime_economic_policy,
)
from app.trading.economic_policy_parity import build_economic_policy_parity_report
from tests.live_config_manifest_contract.support import _load_knative_env, _repo_root

_EXPECTED_POLICY_PATH = "/app/config/economic-policy-v1.json"


def _deployment_env(relative_path: str) -> dict[str, object]:
    payload = safe_load((_repo_root() / relative_path).read_text(encoding="utf-8"))
    spec = cast(Mapping[str, object], payload["spec"])
    template = cast(Mapping[str, object], spec["template"])
    pod_spec = cast(Mapping[str, object], template["spec"])
    container = cast(list[Mapping[str, object]], pod_spec["containers"])[0]
    return {
        str(item["name"]): item.get("value")
        for item in cast(list[Mapping[str, object]], container["env"])
        if "value" in item
    }


def test_all_execution_stages_pin_the_same_policy_and_one_x_gross_cap() -> None:
    policy = load_economic_policy()
    environments = {
        "api": _load_knative_env("argocd/applications/torghut/knative-service.yaml"),
        "shadow": _deployment_env(
            "argocd/applications/torghut/scheduler-deployment.yaml"
        ),
        "paper": _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        ),
    }
    loaded_policies = {}
    for stage, environment in environments.items():
        assert environment["TRADING_ECONOMIC_POLICY_PATH"] == _EXPECTED_POLICY_PATH
        assert environment["TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST"] == policy.digest
        assert Decimal(
            str(environment["TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"])
        ) == Decimal("1.0")
        assert Decimal(
            str(environment["TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE_PCT_EQUITY"])
        ) == Decimal("1.0")
        assert Decimal(str(environment["TRADING_MAX_PARTICIPATION_RATE"])) == Decimal(
            "0.10"
        )
        local_environment = {
            **environment,
            "TRADING_ECONOMIC_POLICY_PATH": str(DEFAULT_ECONOMIC_POLICY_PATH),
        }
        runtime_settings = Settings(_env_file=None, **local_environment)
        loaded_policy = load_runtime_economic_policy(runtime_settings, required=True)
        assert loaded_policy is not None
        loaded_policies[stage] = loaded_policy

    report = build_economic_policy_parity_report(
        {
            "replay": policy,
            "shadow": loaded_policies["shadow"],
            "paper": loaded_policies["paper"],
        }
    )
    assert report["parity"] is True


def test_replay_has_no_test_mock_or_stage_specific_quote_overrides() -> None:
    root = _repo_root()
    replay_loop = (
        root / "services/torghut/scripts/intraday_tsmom_replay/replay_loop.py"
    ).read_text(encoding="utf-8")
    cli_args = (
        root / "services/torghut/scripts/intraday_tsmom_replay/cli_args.py"
    ).read_text(encoding="utf-8")
    assert "unittest.mock" not in replay_loop
    assert "patch.object" not in replay_loop
    assert "--max-executable-spread-bps" not in cli_args
    assert "--max-quote-mid-jump-bps" not in cli_args


def test_enabled_strategy_envelopes_cannot_exceed_the_economic_policy() -> None:
    policy = load_economic_policy()
    configmap = safe_load(
        (
            _repo_root() / "argocd/applications/torghut/strategy-configmap.yaml"
        ).read_text(encoding="utf-8")
    )
    strategy_document = safe_load(configmap["data"]["strategies.yaml"])
    for strategy in strategy_document["strategies"]:
        if strategy.get("enabled") is not True:
            continue
        configured_gross = strategy.get("params", {}).get(
            "max_gross_exposure_pct_equity"
        )
        if configured_gross is None:
            continue
        assert Decimal(str(configured_gross)) <= (
            policy.sizing.max_gross_exposure_pct_equity
        ), strategy["name"]

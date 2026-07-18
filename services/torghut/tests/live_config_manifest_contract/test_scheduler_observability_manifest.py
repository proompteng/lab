from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Mapping, cast
from unittest import TestCase

from yaml import safe_load


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "argocd").is_dir() and (parent / "services" / "torghut").is_dir():
            return parent
    raise AssertionError("repository root not found")


def _configmap_data(relative_path: str, key: str) -> str:
    manifest = safe_load((_repo_root() / relative_path).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise AssertionError(f"{relative_path} did not parse to a mapping")
    data = manifest.get("data")
    if not isinstance(data, dict) or not isinstance(data.get(key), str):
        raise AssertionError(f"{relative_path} missing data[{key!r}]")
    return cast(str, data[key])


def _mimir_groups() -> list[Mapping[str, object]]:
    rules_yaml = _configmap_data(
        "argocd/applications/observability/graf-mimir-rules.yaml",
        "graf-rules.yaml",
    )
    payload = safe_load(rules_yaml)
    if not isinstance(payload, dict) or not isinstance(payload.get("groups"), list):
        raise AssertionError("embedded Mimir rules are malformed")
    return cast(list[Mapping[str, object]], payload["groups"])


class SchedulerObservabilityManifestTests(TestCase):
    def test_scheduler_inventory_metrics_are_enabled(self) -> None:
        values = safe_load(
            (
                _repo_root()
                / "argocd/applications/observability/kube-state-metrics-values.yaml"
            ).read_text(encoding="utf-8")
        )
        self.assertIsInstance(values, dict)
        collectors = cast(dict[str, object], values).get("collectors")
        self.assertIsInstance(collectors, list)
        self.assertIn("services", cast(list[object], collectors))

        alloy_config = (
            _repo_root()
            / "argocd/applications/observability/cluster-metrics-alloy-config.river"
        ).read_text(encoding="utf-8")
        self.assertIn("kube_deployment_spec_replicas", alloy_config)
        self.assertIn("kube_service_info", alloy_config)

    def test_api_availability_and_scheduler_availability_have_distinct_targets(
        self,
    ) -> None:
        trading_group = next(
            group
            for group in _mimir_groups()
            if group.get("name") == "torghut-trading.rules"
        )
        rules = cast(list[Mapping[str, object]], trading_group["rules"])
        by_alert = {str(rule["alert"]): rule for rule in rules}

        api_missing = str(by_alert["TorghutApiServiceMissing"]["expr"])
        api_down = str(by_alert["TorghutActiveApiRevisionMetricsDown"]["expr"])
        self.assertIn("kube_service_info", api_missing)
        self.assertIn('service="torghut"', api_missing)
        self.assertIn('service="torghut"', api_down)
        self.assertNotIn("-private", api_down)
        self.assertNotIn('service="torghut-scheduler"', api_missing)
        self.assertNotIn('service="torghut-scheduler"', api_down)

        for alert in ("TorghutSchedulerMetricsMissing", "TorghutSchedulerMetricsDown"):
            expr = str(by_alert[alert]["expr"])
            self.assertIn('service="torghut-scheduler"', expr)
            self.assertIn('deployment="torghut-scheduler"', expr)
            self.assertIn("kube_deployment_spec_replicas", expr)

        writer_expr = str(by_alert["TorghutSchedulerWriterCountInvalid"]["expr"])
        leadership_expr = str(by_alert["TorghutSchedulerLeadershipUnhealthy"]["expr"])
        self.assertIn("torghut_scheduler_leadership_acquired", writer_expr)
        self.assertIn("sum by (namespace)", writer_expr)
        self.assertIn(") != 1", writer_expr)
        self.assertIn("torghut_scheduler_leadership_healthy", leadership_expr)
        for expr in (writer_expr, leadership_expr):
            self.assertIn('service="torghut-scheduler"', expr)
            self.assertIn("kube_deployment_spec_replicas", expr)
            self.assertIn('deployment="torghut-scheduler"', expr)

    def test_every_torghut_trading_rule_reads_scheduler_metrics(self) -> None:
        expressions = [
            str(rule.get("expr", ""))
            for group in _mimir_groups()
            for rule in cast(list[Mapping[str, object]], group.get("rules", []))
            if "torghut_trading_" in str(rule.get("expr", ""))
        ]
        self.assertTrue(expressions)
        for expression in expressions:
            self.assertIn('service="torghut-scheduler"', expression)
            self.assertNotIn('service="torghut"', expression)

    def test_execution_dashboard_reads_scheduler_metrics(self) -> None:
        dashboard_json = _configmap_data(
            "argocd/applications/observability/torghut-execution-recovery-dashboard-configmap.yaml",
            "torghut-execution-recovery-dashboard.json",
        )
        dashboard = json.loads(dashboard_json)
        expressions = [
            str(target.get("expr", ""))
            for panel in dashboard.get("panels", [])
            for target in panel.get("targets", [])
            if "torghut_trading_" in str(target.get("expr", ""))
        ]
        self.assertTrue(expressions)
        for expression in expressions:
            self.assertIn('service="torghut-scheduler"', expression)
            self.assertNotIn('service="torghut"', expression)

    def test_namespace_alloy_scrapes_api_through_stable_route(self) -> None:
        alloy_config = _configmap_data(
            "argocd/applications/torghut/alloy-configmap.yaml",
            "config.river",
        )
        self.assertIn('regex         = "metric(s)?;.*"', alloy_config)
        self.assertIn('prometheus.scrape "torghut_api"', alloy_config)
        self.assertIn(
            '"__address__" = "torghut.torghut.svc.cluster.local:80"',
            alloy_config,
        )
        self.assertNotIn("torghut-[0-9]{5}-private", alloy_config)

    def test_alloy_config_digest_rolls_deployment(self) -> None:
        alloy_config = _configmap_data(
            "argocd/applications/torghut/alloy-configmap.yaml",
            "config.river",
        )
        deployment = safe_load(
            (
                _repo_root() / "argocd/applications/torghut/alloy-deployment.yaml"
            ).read_text(encoding="utf-8")
        )
        annotations = deployment["spec"]["template"]["metadata"]["annotations"]

        self.assertEqual(
            annotations.get("torghut.proompteng.ai/alloy-config-sha256"),
            hashlib.sha256(alloy_config.encode()).hexdigest(),
        )

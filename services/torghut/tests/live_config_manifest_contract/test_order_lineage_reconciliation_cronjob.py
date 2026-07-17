from __future__ import annotations

from typing import Mapping, cast
from unittest import TestCase

from tests.live_config_manifest_contract.support import load_yaml_mapping


_MANIFEST_PATH = "argocd/applications/torghut/order-lineage-reconciliation-cronjob.yaml"


def _cronjob_parts() -> tuple[
    Mapping[str, object],
    Mapping[str, object],
    Mapping[str, object],
]:
    manifest = load_yaml_mapping(_MANIFEST_PATH)
    spec = cast(Mapping[str, object], manifest["spec"])
    job_template = cast(Mapping[str, object], spec["jobTemplate"])
    job_spec = cast(Mapping[str, object], job_template["spec"])
    template = cast(Mapping[str, object], job_spec["template"])
    pod_spec = cast(Mapping[str, object], template["spec"])
    containers = cast(list[Mapping[str, object]], pod_spec["containers"])
    if len(containers) != 1:
        raise AssertionError("expected exactly one reconciliation container")
    return job_spec, pod_spec, containers[0]


def _env_by_name(container: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    entries = cast(list[Mapping[str, object]], container.get("env", []))
    result: dict[str, Mapping[str, object]] = {}
    for entry in entries:
        name = entry.get("name")
        if not isinstance(name, str) or name in result:
            raise AssertionError("invalid or duplicate environment entry")
        result[name] = entry
    return result


class OrderLineageReconciliationCronJobTests(TestCase):
    def test_cronjob_is_bounded_append_only_and_non_promotional(self) -> None:
        manifest = load_yaml_mapping(_MANIFEST_PATH)
        metadata = cast(Mapping[str, object], manifest["metadata"])
        spec = cast(Mapping[str, object], manifest["spec"])
        job_spec, pod_spec, container = _cronjob_parts()

        self.assertEqual(metadata["name"], "torghut-order-lineage-reconciliation")
        self.assertEqual(metadata["namespace"], "torghut")
        self.assertTrue(spec["suspend"])
        self.assertEqual(spec["schedule"], "12 * * * *")
        self.assertEqual(spec["timeZone"], "America/New_York")
        self.assertEqual(spec["concurrencyPolicy"], "Forbid")
        self.assertEqual(job_spec["backoffLimit"], 0)
        self.assertEqual(job_spec["activeDeadlineSeconds"], 1200)
        self.assertEqual(pod_spec["restartPolicy"], "Never")
        self.assertFalse(pod_spec["automountServiceAccountToken"])
        self.assertNotIn("serviceAccountName", pod_spec)
        self.assertEqual(
            container["command"],
            ["python", "scripts/reconcile_cross_dsn_order_feed_links.py"],
        )
        self.assertEqual(
            container["args"],
            ["--apply", "--json", "--environment", "paper"],
        )

    def test_cronjob_uses_secret_refs_without_account_label_or_broker_keys(
        self,
    ) -> None:
        _job_spec, _pod_spec, container = _cronjob_parts()
        env = _env_by_name(container)

        expected_secret_keys = {
            "DB_DSN": "uri",
            "TORGHUT_SIM_DB_HOST": "host",
            "TORGHUT_SIM_DB_PORT": "port",
            "TORGHUT_SIM_DB_USER": "username",
            "TORGHUT_SIM_DB_PASSWORD": "password",
        }
        for name, secret_key in expected_secret_keys.items():
            value_from = cast(Mapping[str, object], env[name]["valueFrom"])
            secret_ref = cast(Mapping[str, object], value_from["secretKeyRef"])
            self.assertEqual(secret_ref["name"], "torghut-db-app")
            self.assertEqual(secret_ref["key"], secret_key)

        self.assertNotIn("TRADING_ACCOUNT_LABEL", env)
        self.assertNotIn("SIM_TRADING_ACCOUNT_LABEL", env)
        self.assertNotIn("APCA_API_KEY_ID", env)
        self.assertNotIn("APCA_API_SECRET_KEY", env)
        sim_dsn = str(env["SIM_DB_DSN"]["value"])
        self.assertIn("$(TORGHUT_SIM_DB_PASSWORD)", sim_dsn)

    def test_cronjob_tracks_exact_build_and_is_rendered(self) -> None:
        _job_spec, _pod_spec, container = _cronjob_parts()
        env = _env_by_name(container)
        image = str(container["image"])
        digest = str(env["TORGHUT_IMAGE_DIGEST"]["value"])
        commit = str(env["TORGHUT_COMMIT"]["value"])

        self.assertTrue(image.endswith(f"@{digest}"))
        self.assertEqual(len(digest.removeprefix("sha256:")), 64)
        self.assertEqual(len(commit), 40)
        kustomization = load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = cast(list[str], kustomization["resources"])
        self.assertIn("order-lineage-reconciliation-cronjob.yaml", resources)

from __future__ import annotations

from typing import Mapping, cast
from unittest import TestCase

from tests.live_config_manifest_contract.support import _load_yaml_mapping


_MANIFEST_PATH = (
    "argocd/applications/torghut/broker-economic-ledger-reconciliation-cronjob.yaml"
)


def _cronjob_parts() -> tuple[
    Mapping[str, object],
    Mapping[str, object],
    Mapping[str, object],
    Mapping[str, object],
]:
    manifest = _load_yaml_mapping(_MANIFEST_PATH)
    spec = cast(Mapping[str, object], manifest["spec"])
    job_template = cast(Mapping[str, object], spec["jobTemplate"])
    job_spec = cast(Mapping[str, object], job_template["spec"])
    template = cast(Mapping[str, object], job_spec["template"])
    pod_spec = cast(Mapping[str, object], template["spec"])
    containers = cast(list[Mapping[str, object]], pod_spec["containers"])
    if len(containers) != 1:
        raise AssertionError("expected exactly one reconciliation container")
    return manifest, job_spec, pod_spec, containers[0]


def _env_by_name(container: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    entries = cast(list[Mapping[str, object]], container.get("env", []))
    result: dict[str, Mapping[str, object]] = {}
    for entry in entries:
        name = entry.get("name")
        if not isinstance(name, str):
            raise AssertionError("environment entry missing name")
        if name in result:
            raise AssertionError(f"duplicate environment entry: {name}")
        result[name] = entry
    return result


class BrokerEconomicLedgerReconciliationCronJobTests(TestCase):
    def test_cronjob_is_bounded_singleton_observation_only(self) -> None:
        manifest, job_spec, pod_spec, container = _cronjob_parts()
        metadata = cast(Mapping[str, object], manifest["metadata"])
        spec = cast(Mapping[str, object], manifest["spec"])

        self.assertEqual(manifest["kind"], "CronJob")
        self.assertEqual(
            metadata["name"], "torghut-broker-economic-ledger-reconciliation"
        )
        self.assertEqual(metadata["namespace"], "torghut")
        self.assertEqual(spec["schedule"], "47 * * * *")
        self.assertEqual(spec["timeZone"], "America/New_York")
        self.assertEqual(spec["concurrencyPolicy"], "Forbid")
        self.assertEqual(spec["startingDeadlineSeconds"], 900)
        self.assertEqual(job_spec["backoffLimit"], 0)
        self.assertEqual(job_spec["activeDeadlineSeconds"], 1200)
        self.assertEqual(pod_spec["restartPolicy"], "Never")
        self.assertFalse(pod_spec["automountServiceAccountToken"])
        self.assertNotIn("serviceAccountName", pod_spec)
        pod_security = cast(Mapping[str, object], pod_spec["securityContext"])
        self.assertTrue(pod_security["runAsNonRoot"])
        self.assertEqual(pod_security["runAsUser"], 999)
        seccomp = cast(Mapping[str, object], pod_security["seccompProfile"])
        self.assertEqual(seccomp["type"], "RuntimeDefault")
        container_security = cast(Mapping[str, object], container["securityContext"])
        capabilities = cast(Mapping[str, object], container_security["capabilities"])
        self.assertFalse(container_security["allowPrivilegeEscalation"])
        self.assertEqual(capabilities["drop"], ["ALL"])
        self.assertEqual(
            container["command"],
            ["python", "scripts/replay_broker_economic_ledger.py"],
        )
        self.assertEqual(
            container["args"],
            ["--observe", "--max-source-age-seconds", "300"],
        )
        invocation = " ".join(
            str(item)
            for item in [
                *cast(list[object], container["command"]),
                *cast(list[object], container["args"]),
            ]
        )
        self.assertNotIn("--publish-token", invocation)

    def test_cronjob_uses_paper_broker_secret_and_exact_build_identity(self) -> None:
        _manifest, _job_spec, _pod_spec, container = _cronjob_parts()
        env = _env_by_name(container)

        expected_secret_keys = {
            "DB_DSN": ("torghut-db-app", "uri"),
            "APCA_API_KEY_ID": ("torghut-alpaca", "APCA_API_KEY_ID"),
            "APCA_API_SECRET_KEY": (
                "torghut-alpaca",
                "APCA_API_SECRET_KEY",
            ),
            "APCA_API_BASE_URL": ("torghut-alpaca", "APCA_API_BASE_URL"),
        }
        for name, (secret_name, secret_key) in expected_secret_keys.items():
            value_from = cast(Mapping[str, object], env[name]["valueFrom"])
            secret_ref = cast(Mapping[str, object], value_from["secretKeyRef"])
            self.assertEqual(secret_ref["name"], secret_name)
            self.assertEqual(secret_ref["key"], secret_key)

        image = str(container["image"])
        digest = str(env["TORGHUT_IMAGE_DIGEST"]["value"])
        commit = str(env["TORGHUT_COMMIT"]["value"])
        version = str(env["TORGHUT_VERSION"]["value"])
        self.assertTrue(image.endswith(f"@{digest}"))
        self.assertTrue(digest.startswith("sha256:"))
        self.assertEqual(len(digest.removeprefix("sha256:")), 64)
        self.assertEqual(len(commit), 40)
        described_commit = version.rsplit("-g", maxsplit=1)[-1]
        self.assertGreaterEqual(len(described_commit), 7)
        self.assertTrue(commit.startswith(described_commit))
        self.assertEqual(env["TRADING_MODE"]["value"], "live")
        self.assertNotIn("BROKER_ECONOMIC_LEDGER_PUBLISH_TOKEN", env)

    def test_cronjob_is_rendered_by_torghut_kustomization(self) -> None:
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = cast(list[str], kustomization["resources"])

        self.assertIn(
            "broker-economic-ledger-reconciliation-cronjob.yaml",
            resources,
        )

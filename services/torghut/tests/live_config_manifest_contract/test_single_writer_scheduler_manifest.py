from __future__ import annotations

from pathlib import Path
from typing import Mapping, cast
from unittest import TestCase

from yaml import safe_load


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "argocd").is_dir() and (parent / "services" / "torghut").is_dir():
            return parent
    raise AssertionError("repository root not found")


def _load(relative_path: str) -> dict[str, object]:
    payload = safe_load((_repo_root() / relative_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise AssertionError(f"{relative_path} did not parse to a mapping")
    return cast(dict[str, object], payload)


def _pod_spec(manifest: Mapping[str, object]) -> Mapping[str, object]:
    spec = cast(Mapping[str, object], manifest["spec"])
    template = cast(Mapping[str, object], spec["template"])
    return cast(Mapping[str, object], template["spec"])


def _container(manifest: Mapping[str, object]) -> Mapping[str, object]:
    containers = cast(list[Mapping[str, object]], _pod_spec(manifest)["containers"])
    if len(containers) != 1:
        raise AssertionError("expected exactly one container")
    return containers[0]


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


class SingleWriterSchedulerManifestTests(TestCase):
    def test_api_is_stateless_and_syncs_before_scheduler(self) -> None:
        manifest = _load("argocd/applications/torghut/knative-service.yaml")
        metadata = cast(Mapping[str, object], manifest["metadata"])
        annotations = cast(Mapping[str, object], metadata["annotations"])
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], manifest["spec"])["template"],
        )
        template_metadata = cast(Mapping[str, object], template["metadata"])
        template_annotations = cast(
            Mapping[str, object], template_metadata["annotations"]
        )
        env = _env_by_name(_container(manifest))

        self.assertEqual(annotations["argocd.argoproj.io/sync-wave"], "0")
        self.assertNotIn("autoscaling.knative.dev/minScale", template_annotations)
        self.assertEqual(env["TORGHUT_PROCESS_ROLE"].get("value"), "api")

    def test_scheduler_is_contained_recreate_and_has_dedicated_probes(self) -> None:
        manifest = _load("argocd/applications/torghut/scheduler-deployment.yaml")
        metadata = cast(Mapping[str, object], manifest["metadata"])
        annotations = cast(Mapping[str, object], metadata["annotations"])
        spec = cast(Mapping[str, object], manifest["spec"])
        strategy = cast(Mapping[str, object], spec["strategy"])
        pod_spec = _pod_spec(manifest)
        container = _container(manifest)
        env = _env_by_name(container)

        self.assertEqual(annotations["argocd.argoproj.io/sync-wave"], "2")
        self.assertEqual(spec["replicas"], 0)
        self.assertEqual(spec["revisionHistoryLimit"], 1)
        self.assertEqual(strategy["type"], "Recreate")
        self.assertEqual(pod_spec["serviceAccountName"], "torghut-runtime")
        self.assertEqual(pod_spec["terminationGracePeriodSeconds"], 60)
        self.assertEqual(container["command"], ["uvicorn"])
        self.assertEqual(
            container["args"],
            ["app.scheduler_main:app", "--host", "0.0.0.0", "--port", "8183"],
        )
        self.assertEqual(env["TORGHUT_PROCESS_ROLE"].get("value"), "scheduler")
        self.assertEqual(
            env["TRADING_SCHEDULER_LEADERSHIP_REQUIRED"].get("value"), "true"
        )
        self.assertEqual(
            env["TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS"].get("value"), "5"
        )
        readiness = cast(Mapping[str, object], container["readinessProbe"])
        readiness_http = cast(Mapping[str, object], readiness["httpGet"])
        liveness = cast(Mapping[str, object], container["livenessProbe"])
        liveness_http = cast(Mapping[str, object], liveness["httpGet"])
        self.assertEqual(readiness_http["path"], "/scheduler/readyz")
        self.assertEqual(liveness_http["path"], "/healthz")
        security_context = cast(Mapping[str, object], container["securityContext"])
        seccomp = cast(Mapping[str, object], security_context["seccompProfile"])
        self.assertEqual(seccomp["type"], "Unconfined")

    def test_scheduler_and_api_runtime_environment_cannot_drift(self) -> None:
        api_env = _env_by_name(
            _container(_load("argocd/applications/torghut/knative-service.yaml"))
        )
        scheduler_env = _env_by_name(
            _container(_load("argocd/applications/torghut/scheduler-deployment.yaml"))
        )
        api_env.pop("TORGHUT_PROCESS_ROLE")
        scheduler_env.pop("TORGHUT_PROCESS_ROLE")
        scheduler_only = {
            "TRADING_SCHEDULER_LEADERSHIP_REQUIRED",
            "TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS",
        }
        for name in scheduler_only:
            self.assertNotIn(name, api_env)
            scheduler_env.pop(name)

        self.assertEqual(scheduler_env, api_env)

    def test_scheduler_metrics_service_is_discoverable_by_alloy(self) -> None:
        service = _load("argocd/applications/torghut/scheduler-service.yaml")
        metadata = cast(Mapping[str, object], service["metadata"])
        spec = cast(Mapping[str, object], service["spec"])
        ports = cast(list[Mapping[str, object]], spec["ports"])

        self.assertEqual(metadata["name"], "torghut-scheduler")
        self.assertEqual(
            ports, [{"name": "metrics", "port": 8183, "targetPort": "metrics"}]
        )

    def test_all_single_writer_resources_are_rendered(self) -> None:
        kustomization = _load("argocd/applications/torghut/kustomization.yaml")
        resources = set(cast(list[str], kustomization["resources"]))
        self.assertTrue(
            {
                "scheduler-deployment.yaml",
                "scheduler-service.yaml",
            }.issubset(resources)
        )
        self.assertFalse(
            any("revision-prune" in resource for resource in resources),
            "revision cleanup is a guarded one-time operation, not a persistent Job",
        )

    def test_runtime_image_requires_scheduler_entrypoint(self) -> None:
        dockerfile = (_repo_root() / "services/torghut/Dockerfile").read_text(
            encoding="utf-8"
        )
        self.assertEqual(dockerfile.count("test -f /app/app/scheduler_main.py"), 2)

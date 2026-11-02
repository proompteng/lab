#!/usr/bin/env python3
"""Focused behavioral tests for ``mimir-container-reload.py``."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("mimir-container-reload.py")
SPEC = importlib.util.spec_from_file_location("mimir_container_reload", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
mimir = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mimir
SPEC.loader.exec_module(mimir)


CONFIG_TEXT = """ingest_storage:
  enabled: true
ingester:
  ring:
    unregister_on_shutdown: false
store_gateway:
  sharding_ring:
    unregister_on_shutdown: false
"""
CONFIG_SHA = hashlib.sha256(CONFIG_TEXT.encode()).hexdigest()
BOOT_ID = "12345678-1234-1234-1234-123456789abc"
OLD_CONTAINER = "containerd://old-mimir-container"
NEW_CONTAINER = "containerd://new-mimir-container"
MIMIR_IMAGE_ID = "docker-pullable://docker.io/grafana/mimir@sha256:" + "a" * 64
KAFKA_IMAGE_ID = "docker-pullable://docker.io/apache/kafka-native@sha256:" + "b" * 64


def _labels() -> dict[str, str]:
    return {
        "app.kubernetes.io/version": "3.1.2",
        "helm.sh/chart": "mimir-distributed-6.1.0",
    }


def _statefulset(name: str, replicas: int, *, kafka: bool = False) -> dict[str, Any]:
    component = (
        "kafka"
        if kafka
        else {
            "observability-mimir-ingester": "ingester",
            "observability-mimir-store-gateway": "store-gateway",
            "observability-mimir-compactor": "compactor",
            "observability-mimir-alertmanager": "alertmanager",
        }[name]
    )
    container: dict[str, Any] = {
        "name": component,
        "image": mimir.MIMIR_IMAGE if not kafka else mimir.KAFKA_IMAGE,
    }
    if not kafka:
        container["args"] = [
            f"-target={component}",
            "-config.expand-env=true",
            "-config.file=/etc/mimir/mimir.yaml",
        ]
    return {
        "kind": "StatefulSet",
        "metadata": {"name": name, "namespace": "observability", "labels": _labels()},
        "spec": {
            "replicas": replicas,
            "updateStrategy": {"type": "OnDelete"},
            "template": {
                "metadata": {"labels": _labels()},
                "spec": {"containers": [container]},
            },
        },
    }


def _status(
    container: str,
    container_id: str,
    started_at: str,
    restart_count: int = 0,
    image_id: str | None = None,
) -> dict[str, Any]:
    return {
        "name": container,
        "containerID": container_id,
        "imageID": image_id
        or (KAFKA_IMAGE_ID if container == mimir.KAFKA_CONTAINER else MIMIR_IMAGE_ID),
        "restartCount": restart_count,
        "ready": True,
        "state": {"running": {"startedAt": started_at}},
    }


def _pod(
    name: str,
    uid: str,
    container: str,
    *,
    container_id: str = OLD_CONTAINER,
    started_at: str = "2026-09-08T10:00:00Z",
    restart_count: int = 0,
) -> dict[str, Any]:
    live_container: dict[str, Any] = {
        "name": container,
        "image": mimir.KAFKA_IMAGE
        if container == mimir.KAFKA_CONTAINER
        else mimir.MIMIR_IMAGE,
    }
    if container != mimir.KAFKA_CONTAINER:
        live_container["args"] = [
            f"-target={container}",
            "-config.expand-env=true",
            "-config.file=/etc/mimir/mimir.yaml",
        ]
    return {
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": "observability",
            "uid": uid,
            "resourceVersion": "10",
            "labels": {
                "app.kubernetes.io/component": container,
                "app.kubernetes.io/instance": "observability-mimir",
                "app.kubernetes.io/name": "mimir",
            },
        },
        "spec": {
            "containers": [live_container],
            "volumes": [
                {
                    "name": "storage",
                    "persistentVolumeClaim": {"claimName": f"{name}-data"},
                }
            ],
        },
        "status": {
            "phase": "Running",
            "conditions": [{"type": "Ready", "status": "True"}],
            "containerStatuses": [
                _status(container, container_id, started_at, restart_count)
            ],
        },
    }


class FakeCluster:
    """Controlled kubectl surface used by the workflow tests."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.patched = False
        self.patch_argv: tuple[str, ...] | None = None
        self.post_peer_image_ids: dict[str, str] = {}
        self.config_text = CONFIG_TEXT
        self.pdb_allowed = 1
        self.statefulsets = {
            "observability-mimir-ingester": _statefulset(
                "observability-mimir-ingester", 3
            ),
            "observability-mimir-store-gateway": _statefulset(
                "observability-mimir-store-gateway", 1
            ),
            "observability-mimir-compactor": _statefulset(
                "observability-mimir-compactor", 1
            ),
            "observability-mimir-alertmanager": _statefulset(
                "observability-mimir-alertmanager", 1
            ),
            "observability-mimir-kafka": _statefulset(
                "observability-mimir-kafka", 1, kafka=True
            ),
        }
        self.pods: dict[str, dict[str, Any]] = {}
        for index in range(3):
            name = f"observability-mimir-ingester-{index}"
            self.pods[name] = _pod(name, f"ingester-uid-{index}", "ingester")
        self.pods["observability-mimir-store-gateway-0"] = _pod(
            "observability-mimir-store-gateway-0", "store-uid", "store-gateway"
        )
        self.pods["observability-mimir-compactor-0"] = _pod(
            "observability-mimir-compactor-0", "compactor-uid", "compactor"
        )
        self.pods["observability-mimir-alertmanager-0"] = _pod(
            "observability-mimir-alertmanager-0", "alertmanager-uid", "alertmanager"
        )
        self.pods[mimir.KAFKA_POD] = _pod(
            mimir.KAFKA_POD, "kafka-uid", "kafka", container_id="containerd://kafka"
        )
        self.post_target = copy.deepcopy(self.pods["observability-mimir-ingester-0"])
        self.post_target["metadata"]["resourceVersion"] = "12"
        target_status = _status("ingester", NEW_CONTAINER, "2026-09-08T10:01:00Z", 1)
        target_status["lastState"] = {
            "terminated": {"exitCode": 0, "signal": 0, "reason": "Completed"}
        }
        self.post_target["status"]["containerStatuses"] = [target_status]
        self.post_target["status"]["ephemeralContainerStatuses"] = [
            {
                "name": "mimir-process-term-0-ingester",
                "state": {"terminated": {"exitCode": 0}},
            }
        ]
        self.pvcs: dict[str, dict[str, Any]] = {}
        self.pvs: dict[str, dict[str, Any]] = {}
        for pod in mimir.MIMIR_PODS:
            claim = f"{pod}-data"
            pv_name = f"pv-{pod}"
            pvc_uid = f"pvc-uid-{pod}"
            self.pvcs[claim] = {
                "metadata": {
                    "name": claim,
                    "namespace": "observability",
                    "uid": pvc_uid,
                },
                "spec": {"volumeName": pv_name},
                "status": {"phase": "Bound"},
            }
            self.pvs[pv_name] = {
                "metadata": {"name": pv_name, "uid": f"pv-uid-{pod}"},
                "status": {"phase": "Bound"},
                "spec": {
                    "claimRef": {
                        "name": claim,
                        "namespace": "observability",
                        "uid": pvc_uid,
                    },
                    "csi": {
                        "driver": "rook-ceph.rbd.csi.ceph.com",
                        "volumeHandle": f"handle-{pod}",
                    },
                },
            }

    def __call__(
        self, argv: Sequence[str], _input: str | None, _timeout: float
    ) -> tuple[int, str, str]:
        vector = tuple(argv)
        self.calls.append(vector)
        if vector[:3] != ("kubectl", "--context", "galactic-lan"):
            return 99, "", "wrong context"
        args = vector[3:]
        if args[:4] == ("-n", "observability", "get", "statefulset"):
            return 0, json.dumps(self.statefulsets[args[4]]), ""
        if args[:4] == ("-n", "observability", "get", "pod"):
            pod = args[4]
            value = (
                self.post_target
                if self.patched and pod == "observability-mimir-ingester-0"
                else self.pods[pod]
            )
            if self.patched and pod in self.post_peer_image_ids:
                value = copy.deepcopy(value)
                value["status"]["containerStatuses"][0]["imageID"] = (
                    self.post_peer_image_ids[pod]
                )
            return 0, json.dumps(value), ""
        if args[:4] == ("-n", "observability", "get", "pdb"):
            pdb_name = args[4]
            target_component = next(
                target.component
                for target in mimir.TARGETS.values()
                if target.pdb == pdb_name
            )
            target_count = sum(
                target.statefulset
                == next(
                    candidate.statefulset
                    for candidate in mimir.TARGETS.values()
                    if candidate.pdb == pdb_name
                )
                for target in mimir.TARGETS.values()
                if target.pdb == pdb_name
            )
            return (
                0,
                json.dumps(
                    {
                        "metadata": {
                            "name": pdb_name,
                            "namespace": "observability",
                            "generation": 1,
                        },
                        "spec": {
                            "maxUnavailable": 1,
                            "selector": {
                                "matchLabels": {
                                    "app.kubernetes.io/component": target_component,
                                    "app.kubernetes.io/instance": "observability-mimir",
                                    "app.kubernetes.io/name": "mimir",
                                }
                            },
                        },
                        "status": {
                            "expectedPods": target_count,
                            "currentHealthy": target_count,
                            "desiredHealthy": target_count - 1,
                            "disruptionsAllowed": self.pdb_allowed,
                            "observedGeneration": 1,
                            "disruptedPods": {},
                        },
                    }
                ),
                "",
            )
        if args[:4] == ("-n", "observability", "get", "configmap"):
            return 0, json.dumps({"data": {"mimir.yaml": self.config_text}}), ""
        if args[:4] == ("-n", "observability", "get", "pvc"):
            return 0, json.dumps(self.pvcs[args[4]]), ""
        if len(args) >= 3 and args[:2] == ("get", "pv"):
            return 0, json.dumps(self.pvs[args[2]]), ""
        if args[:5] == (
            "-n",
            "observability",
            "patch",
            "pod",
            "observability-mimir-ingester-0",
        ):
            self.patched = True
            self.patch_argv = vector
            patch = json.loads(args[-1])
            self.pods["observability-mimir-ingester-0"].setdefault("spec", {})[
                "ephemeralContainers"
            ] = [patch[-1]["value"]]
            return 0, "", ""
        return 98, "", f"unhandled command: {args!r}"


class MimirReloadTests(unittest.TestCase):
    def make_config(self, **overrides: Any) -> Any:
        values: dict[str, Any] = {
            "context": "galactic-lan",
            "namespace": "observability",
            "pod": "observability-mimir-ingester-0",
            "timeout": 1.0,
            "poll": 0.0,
        }
        values.update(overrides)
        return mimir.Config(**values)

    def test_context_is_explicit_and_target_allowlist_is_narrow(self) -> None:
        fake = FakeCluster()
        output = mimir.kubectl(
            self.make_config(),
            ("-n", "observability", "get", "pod", mimir.KAFKA_POD, "-o", "json"),
            fake,
        )
        self.assertIn(mimir.KAFKA_POD, output)
        self.assertTrue(
            all(
                call[:3] == ("kubectl", "--context", "galactic-lan")
                for call in fake.calls
            )
        )
        with self.assertRaises(mimir.ReloadError):
            mimir.read_pod(
                self.make_config(), "observability-mimir-distributor-0", fake
            )
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(
                self.make_config(execute=True, context="galactic-tailscale")
            ).validate_config()

    def test_all_six_targets_resolve_their_live_container_name(self) -> None:
        for pod, target in mimir.TARGETS.items():
            with self.subTest(pod=pod):
                self.assertEqual(mimir.target_container_for_pod(pod), target.component)
                helper = mimir.helper_spec(
                    "helper",
                    mimir.APPROVED_UTILITY_IMAGE,
                    target.component,
                    CONFIG_SHA,
                    "1",
                    BOOT_ID,
                )
                self.assertEqual(helper["targetContainerName"], target.component)
                self.assertIn(f"-target={target.component}", helper["command"][2])

    def test_live_pod_image_and_args_fence_ondelete_stale_templates(self) -> None:
        fake = FakeCluster()
        fake.pods["observability-mimir-ingester-1"]["spec"]["containers"][0][
            "image"
        ] = "docker.io/grafana/mimir:3.1.1"
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()
        fake = FakeCluster()
        fake.statefulsets["observability-mimir-kafka"]["spec"]["template"]["spec"][
            "containers"
        ][0]["image"] = "docker.io/bitnami/kafka:3.8.1"
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()
        fake = FakeCluster()
        fake.pods["observability-mimir-store-gateway-0"]["spec"]["containers"][0][
            "args"
        ] = ["-target=compactor"]
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_plan_is_read_only_and_checks_all_five_ondelete_sets(self) -> None:
        fake = FakeCluster()
        result = mimir.Workflow(self.make_config(), runner=fake).run()
        self.assertEqual(result["outcome"], "plan")
        self.assertFalse(fake.patched)
        self.assertEqual(
            len([call for call in fake.calls if call[5:7] == ("get", "statefulset")]),
            5,
        )
        fake.statefulsets["observability-mimir-kafka"]["spec"]["updateStrategy"][
            "type"
        ] = "RollingUpdate"
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_execute_patches_one_ephemeral_helper_and_preserves_peers_kafka_storage(
        self,
    ) -> None:
        fake = FakeCluster()
        result = mimir.Workflow(
            self.make_config(
                execute=True,
                expected_pod_uid="ingester-uid-0",
                expected_container_id=OLD_CONTAINER,
                expected_config_sha256=CONFIG_SHA,
                expected_process_start_ticks="12345",
                expected_boot_id=BOOT_ID,
                utility_image=mimir.APPROVED_UTILITY_IMAGE,
            ),
            runner=fake,
            sleep=lambda _seconds: None,
            readiness_reader=lambda _config, _pod: 200,
        ).run()
        self.assertEqual(result["outcome"], "complete")
        self.assertTrue(fake.patched)
        assert fake.patch_argv is not None
        self.assertNotIn("delete", fake.patch_argv)
        self.assertNotIn("apply", fake.patch_argv)
        patch = json.loads(fake.patch_argv[-1])
        self.assertEqual([item["op"] for item in patch[:2]], ["test", "test"])
        helper_value = patch[-1]["value"]
        helper = helper_value[-1] if isinstance(helper_value, list) else helper_value
        self.assertEqual(helper["targetContainerName"], "ingester")
        self.assertEqual(helper["securityContext"]["runAsUser"], 10001)
        self.assertEqual(helper["securityContext"]["runAsGroup"], 10001)
        self.assertNotIn("env", helper)
        self.assertNotIn("volumeMounts", helper)
        self.assertNotIn("volumes", helper)
        self.assertNotIn("capabilities", helper["securityContext"])

    def test_stale_config_and_pdb_fail_closed_before_patch(self) -> None:
        fake = FakeCluster()
        workflow = mimir.Workflow(self.make_config(), runner=fake)
        state = workflow.preflight()
        fake.config_text += "# drift\n"
        with self.assertRaises(mimir.ReloadError):
            workflow.refresh_before_patch(state)
        fake = FakeCluster()
        fake.pdb_allowed = 0
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_config_safety_requires_unique_explicit_ring_flags(self) -> None:
        self.assertIsNone(mimir.validate_mimir_config(CONFIG_TEXT))
        missing = CONFIG_TEXT.replace(
            "store_gateway:\n  sharding_ring:\n    unregister_on_shutdown: false\n",
            "store_gateway:\n  sharding_ring:\n",
        )
        with self.assertRaises(mimir.ReloadError):
            mimir.validate_mimir_config(missing)
        duplicate = CONFIG_TEXT + (
            "ingester:\n  ring:\n    unregister_on_shutdown: false\n"
        )
        with self.assertRaises(mimir.ReloadError):
            mimir.validate_mimir_config(duplicate)
        with self.assertRaises(mimir.ReloadError):
            mimir.validate_mimir_config(
                CONFIG_TEXT + "ingester:\n  flush_blocks_on_shutdown: true\n"
            )

    def test_pdb_contract_requires_fresh_exact_budget_and_target_selector(self) -> None:
        fake = FakeCluster()
        _, raw, _ = fake(
            (
                "kubectl",
                "--context",
                "galactic-lan",
                "-n",
                "observability",
                "get",
                "pdb",
                "observability-mimir-ingester",
                "-o",
                "json",
            ),
            None,
            1.0,
        )
        target_pods = [fake.pods[name] for name in mimir.INGESTER_PODS]
        base = json.loads(raw)
        for mutation in (
            lambda value: value["spec"].update(maxUnavailable=2),
            lambda value: value["status"].update(observedGeneration=2),
            lambda value: value["status"].update(currentHealthy=2),
            lambda value: value["status"].update(disruptedPods={"uid": "now"}),
            lambda value: value["spec"]["selector"]["matchLabels"].update(
                {"app.kubernetes.io/component": "compactor"}
            ),
        ):
            candidate = copy.deepcopy(base)
            mutation(candidate)
            with self.subTest(candidate=candidate):
                with self.assertRaises(mimir.ReloadError):
                    mimir.validate_pdb(
                        candidate,
                        "observability-mimir-ingester",
                        target_pods,
                        list(fake.pods.values()),
                        "ingester",
                    )

    def test_storage_contract_requires_bound_rbd_and_claim_identity(self) -> None:
        claim = "observability-mimir-ingester-0-data"
        pv_name = "pv-observability-mimir-ingester-0"
        for mutation in (
            lambda fake: fake.pvcs[claim]["status"].update(phase="Pending"),
            lambda fake: fake.pvs[pv_name]["status"].update(phase="Released"),
            lambda fake: fake.pvs[pv_name]["spec"]["csi"].update(
                driver="kubernetes.io/nope"
            ),
            lambda fake: fake.pvs[pv_name]["spec"]["claimRef"].update(
                uid="wrong-pvc-uid"
            ),
            lambda fake: fake.pvcs[claim]["metadata"].update(
                deletionTimestamp="2026-09-08T10:00:00Z"
            ),
        ):
            fake = FakeCluster()
            mutation(fake)
            with self.subTest(mutation=mutation):
                with self.assertRaises(mimir.ReloadError):
                    mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_image_id_digest_is_required_and_fences_postflight(self) -> None:
        fake = FakeCluster()
        del fake.pods["observability-mimir-ingester-1"]["status"]["containerStatuses"][
            0
        ]["imageID"]
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

        fake = FakeCluster()
        fake.post_target["status"]["containerStatuses"][0]["imageID"] = (
            "docker-pullable://docker.io/grafana/mimir@sha256:" + "c" * 64
        )
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(
                self.make_config(
                    execute=True,
                    timeout=0.01,
                    expected_pod_uid="ingester-uid-0",
                    expected_container_id=OLD_CONTAINER,
                    expected_config_sha256=CONFIG_SHA,
                    expected_process_start_ticks="12345",
                    expected_boot_id=BOOT_ID,
                    utility_image=mimir.APPROVED_UTILITY_IMAGE,
                ),
                runner=fake,
                sleep=lambda _seconds: None,
                readiness_reader=lambda _config, _pod: 200,
            ).run()

        fake = FakeCluster()
        fake.post_peer_image_ids["observability-mimir-ingester-1"] = (
            "docker-pullable://docker.io/grafana/mimir@sha256:" + "d" * 64
        )
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(
                self.make_config(
                    execute=True,
                    timeout=0.01,
                    expected_pod_uid="ingester-uid-0",
                    expected_container_id=OLD_CONTAINER,
                    expected_config_sha256=CONFIG_SHA,
                    expected_process_start_ticks="12345",
                    expected_boot_id=BOOT_ID,
                    utility_image=mimir.APPROVED_UTILITY_IMAGE,
                ),
                runner=fake,
                sleep=lambda _seconds: None,
                readiness_reader=lambda _config, _pod: 200,
            ).run()

    def test_existing_helper_serializes_retries(self) -> None:
        fake = FakeCluster()
        fake.pods["observability-mimir-ingester-0"].setdefault("spec", {})[
            "ephemeralContainers"
        ] = [{"name": "mimir-process-term-0-ingester"}]
        with self.assertRaises(mimir.ReloadError):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_unfinished_peer_helper_blocks_new_reload(self) -> None:
        fake = FakeCluster()
        fake.pods["observability-mimir-ingester-1"].setdefault("spec", {})[
            "ephemeralContainers"
        ] = [{"name": "mimir-process-term-7-ingester"}]
        with self.assertRaisesRegex(mimir.ReloadError, "unfinished reload helper"):
            mimir.Workflow(self.make_config(), runner=fake).preflight()

    def test_failed_peer_helper_blocks_next_ready_target(self) -> None:
        for code in range(41, 47):
            with self.subTest(exit_code=code):
                fake = FakeCluster()
                peer = fake.pods["observability-mimir-ingester-1"]
                helper = "mimir-process-term-0-ingester"
                peer["spec"]["ephemeralContainers"] = [{"name": helper}]
                peer["status"]["ephemeralContainerStatuses"] = [
                    {
                        "name": helper,
                        "state": {"terminated": {"exitCode": code}},
                    }
                ]
                with self.assertRaisesRegex(mimir.ReloadError, "reload helper"):
                    mimir.Workflow(self.make_config(), runner=fake).preflight()
                self.assertFalse(fake.patched)
                peer["status"]["ephemeralContainerStatuses"][0]["state"]["terminated"][
                    "exitCode"
                ] = 0
                self.assertEqual(mimir.unfinished_reload_helpers(peer), ())

    def test_config_safety_rejects_flush_and_ring_unregister(self) -> None:
        with self.assertRaises(mimir.ReloadError):
            mimir.validate_mimir_config(
                "ingest_storage:\n  enabled: true\nflush_blocks_on_shutdown: true\n"
            )
        with self.assertRaises(mimir.ReloadError):
            mimir.validate_mimir_config(
                "ingest_storage:\n  enabled: true\ningester:\n  ring:\n    unregister_on_shutdown: true\n"
            )

    def test_previous_exit_rejects_old137_signal_and_oom(self) -> None:
        for terminated in (
            {"exitCode": 137},
            {"exitCode": 0, "signal": 9},
            {"exitCode": 1},
            {"exitCode": 0, "reason": "OOMKilled"},
        ):
            with (
                self.subTest(terminated=terminated),
                self.assertRaises(mimir.ReloadError),
            ):
                mimir.previous_exit({"lastState": {"terminated": terminated}})

    def test_process_stat_parser_handles_spaces_and_parentheses(self) -> None:
        after_comm = ["S"] + ["0"] * 18 + ["12345"]
        line = "42 (mimir worker (compactor)) " + " ".join(after_comm)
        self.assertEqual(mimir.parse_proc_stat_start_ticks(line, pid="42"), "12345")
        with self.assertRaises(mimir.ReloadError):
            mimir.parse_proc_stat_start_ticks(line, pid="43")

    def test_http_transport_failure_is_a_typed_reload_error(self) -> None:
        port_forward = mimir.PortForward(
            self.make_config(), "observability-mimir-ingester-0"
        )
        port_forward.local_port = 39080
        with patch.object(
            mimir, "urlopen", side_effect=OSError("fixture network failure")
        ):
            with self.assertRaises(mimir.ReadinessTransportError):
                port_forward.request()

    def test_readiness_retries_transport_errors_inside_one_forward(self) -> None:
        class Forward:
            instances = 0

            def __init__(self, _config: Any, _pod: str) -> None:
                type(self).instances += 1
                self.requests = 0

            def __enter__(self) -> "Forward":
                return self

            def request(self, _path: str) -> int:
                self.requests += 1
                if self.requests < 3:
                    raise mimir.ReadinessTransportError("not listening yet")
                return 200

            def __exit__(
                self, _exc_type: Any, _exc_value: Any, _traceback: Any
            ) -> None:
                return None

        with (
            patch.object(mimir, "PortForward", Forward),
            patch.object(mimir.time, "monotonic", return_value=0.0),
            patch.object(mimir.time, "sleep"),
        ):
            self.assertEqual(
                mimir.readiness_probe(
                    self.make_config(timeout=1.0),
                    "observability-mimir-ingester-0",
                ),
                200,
            )
        self.assertEqual(Forward.instances, 1)

    def test_portforward_cleanup_failure_is_visible_and_stops_probe_retry(self) -> None:
        class StuckProcess:
            def __init__(self) -> None:
                self.signals: list[int] = []

            def poll(self) -> None:
                return None

            def send_signal(self, value: int) -> None:
                self.signals.append(value)

            def wait(self, timeout: float) -> int:
                del timeout
                raise subprocess.TimeoutExpired("kubectl", 5.0)

        process = StuckProcess()
        pf = mimir.PortForward(
            self.make_config(),
            "observability-mimir-ingester-0",
            popen=lambda *args, **kwargs: process,
        )
        with self.assertRaises(mimir.PortForwardCleanupError):
            with pf:
                raise mimir.ReadinessTransportError("fixture transport failure")
        self.assertEqual(process.signals, [signal.SIGTERM])

        class FailingForward:
            instances = 0

            def __init__(self, _config: Any, _pod: str) -> None:
                type(self).instances += 1

            def __enter__(self) -> "FailingForward":
                return self

            def request(self, _path: str) -> int:
                raise mimir.ReadinessTransportError("fixture transport failure")

            def __exit__(
                self, _exc_type: Any, _exc_value: Any, _traceback: Any
            ) -> None:
                raise mimir.PortForwardCleanupError("fixture cleanup failure")

        with (
            patch.object(mimir, "PortForward", FailingForward),
            patch.object(mimir.time, "monotonic", side_effect=(0.0, 0.0, 2.0)),
        ):
            with self.assertRaises(mimir.PortForwardCleanupError):
                mimir.readiness_probe(
                    self.make_config(timeout=1.0),
                    "observability-mimir-ingester-0",
                )
        self.assertEqual(FailingForward.instances, 1)

    def test_execute_operator_lock_is_secure_and_nonblocking(self) -> None:
        config = self.make_config(execute=True)
        first = mimir.OperatorLock(config)
        with first:
            lock_stat = os.stat(first.path)
            self.assertTrue(stat.S_ISREG(lock_stat.st_mode))
            self.assertEqual(lock_stat.st_uid, os.getuid())
            self.assertEqual(stat.S_IMODE(lock_stat.st_mode), 0o600)
            with self.assertRaises(mimir.ReloadError):
                with mimir.OperatorLock(config):
                    pass
        with mimir.OperatorLock(config):
            pass

    def test_native_shell_fixture_fences_pid_incarnation_and_sends_one_term(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = subprocess.Popen(["sleep", "30"])
            try:
                pid = str(child.pid)
                proc_dir = root / pid
                (proc_dir / "root" / "etc" / "mimir").mkdir(parents=True)
                (root / "sys" / "kernel" / "random").mkdir(parents=True)
                config_path = proc_dir / "root" / "etc" / "mimir" / "mimir.yaml"
                config_path.write_text(CONFIG_TEXT, encoding="utf-8")
                (proc_dir / "cmdline").write_bytes(
                    b"/bin/mimir\0-target=compactor\0-config.file=/etc/mimir/mimir.yaml\0"
                    b"-config.expand-env=true\0"
                )
                (root / "sys" / "kernel" / "random" / "boot_id").write_text(
                    BOOT_ID + "\n", encoding="utf-8"
                )
                after_comm = ["S"] + ["0"] * 18 + ["98765"]
                (proc_dir / "stat").write_text(
                    f"{pid} (mimir worker (compactor)) " + " ".join(after_comm),
                    encoding="utf-8",
                )
                script = mimir.helper_script(
                    "compactor",
                    hashlib.sha256(CONFIG_TEXT.encode()).hexdigest(),
                    "98765",
                    BOOT_ID,
                    proc_root=str(root),
                    target_pid=pid,
                )
                stale_script = mimir.helper_script(
                    "compactor",
                    hashlib.sha256(CONFIG_TEXT.encode()).hexdigest(),
                    "98766",
                    BOOT_ID,
                    proc_root=str(root),
                    target_pid=pid,
                )
                stale = subprocess.run(
                    ["/bin/sh", "-ceu", stale_script],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(stale.returncode, 0)
                self.assertIsNone(child.poll())
                completed = subprocess.run(
                    ["/bin/sh", "-ceu", script],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(child.wait(timeout=5), -signal.SIGTERM)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)

    def test_helper_spec_and_source_forbid_forced_or_shutdown_paths(self) -> None:
        helper = mimir.helper_spec(
            "helper", mimir.APPROVED_UTILITY_IMAGE, "ingester", CONFIG_SHA, "1", BOOT_ID
        )
        self.assertEqual(helper["image"], mimir.APPROVED_UTILITY_IMAGE)
        script = helper["command"][2]
        self.assertNotIn("SIGKILL", script)
        self.assertNotIn("kill -9", script)
        self.assertNotIn("/shutdown", script)
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("kubectl delete", source)
        self.assertNotIn("kill -9", source)
        self.assertNotIn("SIGKILL", source)
        self.assertNotIn("/shutdown", source)

    def test_portforward_cleanup_uses_term_on_failure(self) -> None:
        class Process:
            def __init__(self) -> None:
                self.signals: list[int] = []
                self.exited = False

            def poll(self) -> int | None:
                return 0 if self.exited else None

            def send_signal(self, value: int) -> None:
                self.signals.append(value)
                self.exited = True

            def wait(self, timeout: float) -> int:
                del timeout
                self.exited = True
                return 0

        process = Process()
        pf = mimir.PortForward(
            self.make_config(),
            "observability-mimir-ingester-0",
            popen=lambda *args, **kwargs: process,
        )
        with self.assertRaises(ValueError):
            with pf:
                raise ValueError("fixture failure")
        self.assertEqual(process.signals, [signal.SIGTERM])


if __name__ == "__main__":
    unittest.main(verbosity=2)

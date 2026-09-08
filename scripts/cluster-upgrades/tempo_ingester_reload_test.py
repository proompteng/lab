#!/usr/bin/env python3
"""Focused safety and fencing tests for tempo-ingester-reload.py."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "tempo_ingester_reload", Path(__file__).with_name("tempo-ingester-reload.py")
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


POD_UID = "23643a67-c949-4b48-afee-77999fe1c0ce"
OTHER_UID = "8126090e-52f5-490d-b5d1-9925c8e4e096"
CONTAINER_ID = "containerd://tempo-old-container"
OTHER_CONTAINER_ID = "containerd://tempo-new-container"
CONFIG = "server:\n  http_listen_port: 3200\n"
CONFIG_SHA256 = hashlib.sha256(CONFIG.encode()).hexdigest()
IMAGE = MODULE.APPROVED_UTILITY_IMAGE


def command_output(value: Any, code: int = 0, stderr: str = "") -> tuple[int, str, str]:
    return code, value if isinstance(value, str) else json.dumps(value), stderr


def container_status(
    *,
    container_id: str | None = CONTAINER_ID,
    restart_count: int = 0,
    running: bool = True,
    ready: bool = True,
    previous: dict[str, Any] | None = None,
    started_at: str = "2026-09-08T10:00:00Z",
) -> dict[str, Any]:
    state: dict[str, Any]
    if running:
        state = {"running": {"startedAt": started_at}}
    else:
        state = {"waiting": {"reason": "CrashLoopBackOff"}}
    result: dict[str, Any] = {
        "name": MODULE.TARGET_CONTAINER,
        "restartCount": restart_count,
        "ready": ready,
        "state": state,
    }
    if container_id is not None:
        result["containerID"] = container_id
    if previous is not None:
        result["lastState"] = {"terminated": previous}
    return result


def pod(
    *,
    name: str = "observability-tempo-ingester-0",
    uid: str = POD_UID,
    resource_version: str = "10",
    container_id: str | None = CONTAINER_ID,
    restart_count: int = 0,
    running: bool = True,
    ready: bool = True,
    previous: dict[str, Any] | None = None,
    started_at: str = "2026-09-08T10:00:00Z",
    ephemeral: list[dict[str, Any]] | None | object = None,
    omit_ephemeral: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "metadata": {
            "name": name,
            "namespace": "observability",
            "uid": uid,
            "resourceVersion": resource_version,
        },
        "spec": {"containers": [{"name": MODULE.TARGET_CONTAINER}]},
        "status": {
            "phase": "Running" if running else "Pending",
            "podIP": f"10.244.0.{int(name.rsplit('-', 1)[-1]) + 1}",
            "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
            "containerStatuses": [
                container_status(
                    container_id=container_id,
                    restart_count=restart_count,
                    running=running,
                    ready=ready,
                    previous=previous,
                    started_at=started_at,
                )
            ],
        },
    }
    if not omit_ephemeral:
        payload["spec"]["ephemeralContainers"] = copy.deepcopy(
            [] if ephemeral is None else ephemeral
        )
    return payload


def sts() -> dict[str, Any]:
    return {"spec": {"replicas": 3, "updateStrategy": {"type": "OnDelete"}}}


def pdb() -> dict[str, Any]:
    return {"spec": {"maxUnavailable": 1}, "status": {"disruptionsAllowed": 1}}


def ring() -> MODULE.RingSnapshot:
    names = (
        "observability-tempo-ingester-0",
        "observability-tempo-ingester-1",
        "observability-tempo-ingester-2",
    )
    return MODULE.RingSnapshot(
        names,
        names,
        tuple((name, f"10.244.0.{index + 1}:9095") for index, name in enumerate(names)),
        tuple((name, "1s ago (11:22:22)") for name in names),
    )


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += max(seconds, 0.01)


class FakeKubectl:
    """Fake the exact read/patch/log boundaries used by Workflow."""

    def __init__(
        self,
        *,
        refresh_uid: str = POD_UID,
        refresh_container_id: str = CONTAINER_ID,
        refresh_running: bool = True,
        refresh_restart_count: int = 0,
        config: str = CONFIG,
        patch_code: int = 0,
        existing_ephemeral: list[dict[str, Any]] | None = None,
        transient_restart_state: bool = False,
    ) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.target_reads = 0
        self.patched = False
        self.patch_code = patch_code
        self.refresh_uid = refresh_uid
        self.refresh_container_id = refresh_container_id
        self.refresh_running = refresh_running
        self.refresh_restart_count = refresh_restart_count
        self.config = config
        self.existing_ephemeral = copy.deepcopy(existing_ephemeral or [])
        self.helper_name: str | None = None
        self.transient_restart_state = transient_restart_state
        self.wait_reads = 0

    def __call__(
        self, argv: Sequence[str], input_text: str | None, timeout: float
    ) -> tuple[int, str, str]:
        del input_text, timeout
        args = tuple(argv)
        self.calls.append(args)
        if args[:3] != ("kubectl", "--context", "galactic-lan"):
            raise AssertionError(f"missing explicit context: {args!r}")
        command = args[3:]
        if command[:2] == ("-n", "observability") and command[2:4] == (
            "get",
            "statefulset",
        ):
            return command_output(sts())
        if command[:2] == ("-n", "observability") and command[2:4] == ("get", "pods"):
            return command_output(
                {"items": [self.ready_pod(index) for index in range(3)]}
            )
        if command[:2] == ("-n", "observability") and command[2:4] == ("get", "pdb"):
            return command_output(pdb())
        if command[:2] == ("-n", "observability") and command[2:4] == (
            "get",
            "configmap",
        ):
            return command_output({"data": {MODULE.CONFIG_KEY: self.config}})
        if command[:2] == ("-n", "observability") and command[2:4] == ("get", "pod"):
            self.target_reads += 1
            if self.patched:
                self.wait_reads += 1
            return command_output(self.target_payload())
        if command[:2] == ("-n", "observability") and command[2:4] == ("patch", "pod"):
            if self.patch_code != 0:
                return command_output(
                    "", self.patch_code, "Conflict: stale resourceVersion"
                )
            patch = json.loads(command[command.index("--patch") + 1])
            self.apply_patch(patch)
            return command_output(self.target_payload())
        if command[:2] == ("-n", "observability") and command[2] == "logs":
            return command_output(
                "level=info msg=starting WAL replay token=do-not-log\n"
                "level=info msg=flush queue drained\n"
            )
        raise AssertionError(f"unexpected command: {args!r}")

    def ready_pod(self, index: int) -> dict[str, Any]:
        pod_name = f"observability-tempo-ingester-{index}"
        return pod(name=pod_name, uid=f"{index:08d}-0000-0000-0000-000000000000")

    def target_payload(self) -> dict[str, Any]:
        if self.patched:
            if self.transient_restart_state and self.wait_reads == 1:
                transient = pod(
                    uid=POD_UID,
                    resource_version="12",
                    container_id=None,
                    restart_count=1,
                    running=False,
                    ready=False,
                    ephemeral=self.existing_ephemeral,
                )
                helper = {
                    "name": self.helper_name,
                    "state": {"running": {"startedAt": "2026-09-08T10:01:00Z"}},
                }
                transient["status"]["ephemeralContainerStatuses"] = [helper]
                return transient
            payload = pod(
                uid=POD_UID,
                resource_version="12",
                container_id=OTHER_CONTAINER_ID,
                restart_count=1,
                started_at="2026-09-08T10:01:03Z",
                previous={
                    "reason": "Completed",
                    "exitCode": 0,
                    "finishedAt": "2026-09-08T10:01:00Z",
                },
                ephemeral=self.existing_ephemeral,
            )
            helper = {
                "name": self.helper_name,
                "state": {"terminated": {"exitCode": 0, "reason": "Completed"}},
            }
            payload["status"]["ephemeralContainerStatuses"] = [helper]
            return payload
        if self.target_reads > 1:
            return pod(
                uid=self.refresh_uid,
                resource_version="11",
                container_id=self.refresh_container_id,
                restart_count=self.refresh_restart_count,
                running=self.refresh_running,
                ready=self.refresh_running,
                ephemeral=self.existing_ephemeral,
            )
        return pod(
            uid=POD_UID, resource_version="10", ephemeral=self.existing_ephemeral
        )

    def apply_patch(self, patch: list[dict[str, Any]]) -> None:
        self.assert_patch_fence(patch)
        add = patch[-1]
        if add["op"] == "add" and add["path"] == "/spec/ephemeralContainers/-":
            helper = copy.deepcopy(add["value"])
            self.existing_ephemeral.append(helper)
        elif add["op"] == "add" and add["path"] == "/spec/ephemeralContainers":
            self.existing_ephemeral = copy.deepcopy(add["value"])
        else:
            raise AssertionError(f"unexpected append operation: {add!r}")
        self.helper_name = self.existing_ephemeral[-1]["name"]
        self.patched = True

    @staticmethod
    def assert_patch_fence(patch: list[dict[str, Any]]) -> None:
        assert patch[0] == {"op": "test", "path": "/metadata/uid", "value": POD_UID}
        assert patch[1] == {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": "11",
        }


def config(**overrides: Any) -> MODULE.Config:
    values: dict[str, Any] = {
        "context": "galactic-lan",
        "namespace": "observability",
        "pod": "observability-tempo-ingester-0",
        "expected_pod_uid": POD_UID,
        "expected_container_id": CONTAINER_ID,
        "expected_config_sha256": CONFIG_SHA256,
        "utility_image": IMAGE,
        "execute": True,
        "timeout": 1.0,
        "poll": 0.1,
        "command_timeout": 1.0,
    }
    values.update(overrides)
    return MODULE.Config(**values)


class TempoReloadTests(unittest.TestCase):
    def workflow(
        self,
        runner: FakeKubectl,
        *,
        ring_reader: Any = None,
        **overrides: Any,
    ) -> MODULE.Workflow:
        clock = Clock()
        return MODULE.Workflow(
            config(**overrides),
            runner,
            clock=clock,
            sleep=clock.sleep,
            ring_reader=ring_reader or (lambda _config, _runner: ring()),
        )

    def test_success_appends_one_helper_and_waits_for_safe_restart(self) -> None:
        runner = FakeKubectl()
        result = self.workflow(runner).run()
        self.assertEqual(result["outcome"], "complete")
        patches = [
            call for call in runner.calls if "--subresource=ephemeralcontainers" in call
        ]
        self.assertEqual(len(patches), 1)
        patch = json.loads(patches[0][patches[0].index("--patch") + 1])
        helper = patch[-1]["value"]
        self.assertEqual(helper["targetContainerName"], "ingester")
        self.assertEqual(helper["securityContext"]["runAsUser"], 1000)
        self.assertEqual(helper["securityContext"]["runAsGroup"], 1000)
        self.assertFalse(helper["securityContext"]["privileged"])
        self.assertFalse(helper["securityContext"]["allowPrivilegeEscalation"])
        self.assertEqual(helper["securityContext"]["capabilities"], {"drop": ["ALL"]})
        self.assertNotIn("env", helper)
        self.assertNotIn("volumeMounts", helper)
        self.assertEqual(result["result"]["previousExit"]["exitCode"], 0)
        self.assertEqual(result["result"]["oldContainerID"], CONTAINER_ID)
        self.assertEqual(result["result"]["newContainerID"], OTHER_CONTAINER_ID)
        self.assertNotEqual(
            result["result"]["oldStartedAt"], result["result"]["newStartedAt"]
        )
        self.assertEqual(
            result["result"]["previousShutdownLogs"],
            [
                "level=info msg=starting WAL replay token=[REDACTED]",
                "level=info msg=flush queue drained",
            ],
        )
        self.assertEqual(
            result["result"]["currentStartupLogs"],
            result["result"]["previousShutdownLogs"],
        )
        self.assertEqual(result["result"]["ring"]["activeIDs"], list(ring().active_ids))
        self.assertEqual(
            result["result"]["ring"]["activeAddresses"][ring().active_ids[0]],
            "10.244.0.1:9095",
        )
        log_calls = [
            call
            for call in runner.calls
            if call[3:5] == ("-n", "observability") and "logs" in call
        ]
        self.assertEqual(len(log_calls), 2)
        self.assertIn("--previous", log_calls[0])
        self.assertNotIn("--previous", log_calls[1])

    def test_result_and_audit_file_are_json_serializable_with_ring_evidence(
        self,
    ) -> None:
        runner = FakeKubectl()
        with tempfile.TemporaryDirectory() as directory:
            audit_path = Path(directory) / "tempo-reload.json"
            result = self.workflow(runner, audit_path=audit_path).run()
            encoded = json.dumps(result)
            self.assertIn('"activeIDs"', encoded)
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            self.assertEqual(
                audit["result"]["ring"]["heartbeats"][ring().active_ids[0]],
                "1s ago (11:22:22)",
            )

    def test_restart_wait_tolerates_transient_missing_container_id(self) -> None:
        runner = FakeKubectl(transient_restart_state=True)
        result = self.workflow(runner).run()
        self.assertEqual(result["outcome"], "complete")
        self.assertGreaterEqual(runner.wait_reads, 2)

    def test_plan_is_read_only_and_can_preview_the_fenced_patch(self) -> None:
        runner = FakeKubectl()
        result = self.workflow(runner, execute=False).run()
        self.assertEqual(result["outcome"], "plan")
        self.assertIn("patchPreview", result)
        self.assertFalse(
            any("--subresource=ephemeralcontainers" in call for call in runner.calls)
        )

    def test_post_restart_ring_lag_is_retried_within_bound(self) -> None:
        responses = iter(
            [
                ring(),
                MODULE.RingSnapshot(("observability-tempo-ingester-0",)),
                ring(),
            ]
        )

        def ring_reader(_config: MODULE.Config, _runner: Any) -> MODULE.RingSnapshot:
            return next(responses)

        runner = FakeKubectl()
        result = self.workflow(runner, ring_reader=ring_reader).run()
        self.assertEqual(result["outcome"], "complete")
        self.assertTrue(
            any(event["name"] == "ring-not-yet-ready" for event in result["events"])
        )

    def test_port_forward_failed_enter_sends_term_and_waits_for_cleanup(self) -> None:
        class Process:
            def __init__(self) -> None:
                self.signals: list[int] = []
                self.waited = False

            def poll(self) -> None:
                return None

            def send_signal(self, value: int) -> None:
                self.signals.append(value)

            def wait(self, timeout: float) -> None:
                del timeout
                self.waited = True

        process = Process()
        port_forward = MODULE.PortForward(config(timeout=0.1))
        with (
            mock.patch.object(MODULE.PortForward, "free_port", return_value=32123),
            mock.patch.object(MODULE.subprocess, "Popen", return_value=process),
            mock.patch.object(MODULE.time, "monotonic", side_effect=[0.0, 1.0]),
        ):
            with self.assertRaisesRegex(MODULE.ReloadError, "did not become ready"):
                port_forward.__enter__()
        self.assertEqual(process.signals, [signal.SIGTERM])
        self.assertTrue(process.waited)

    def test_stale_uid_on_second_read_aborts_before_patch(self) -> None:
        runner = FakeKubectl(refresh_uid=OTHER_UID)
        with self.assertRaisesRegex(MODULE.ReloadError, "UID changed"):
            self.workflow(runner).run()
        self.assertFalse(
            any("--subresource=ephemeralcontainers" in call for call in runner.calls)
        )

    def test_nonrunning_target_on_second_read_aborts_before_patch(self) -> None:
        runner = FakeKubectl(refresh_running=False)
        with self.assertRaisesRegex(MODULE.ReloadError, "not Running"):
            self.workflow(runner).run()
        self.assertFalse(
            any("--subresource=ephemeralcontainers" in call for call in runner.calls)
        )

    def test_terminating_target_is_rejected_before_identity_use(self) -> None:
        terminating = pod()
        terminating["metadata"]["deletionTimestamp"] = "2026-09-08T10:00:00Z"
        with self.assertRaisesRegex(MODULE.ReloadError, "terminating"):
            MODULE.validate_target_identity(
                terminating,
                expected_uid=POD_UID,
                expected_container_id=CONTAINER_ID,
            )

    def test_force_exit_137_without_signal_is_rejected(self) -> None:
        status = container_status(
            previous={"reason": "Error", "exitCode": 137},
        )
        with self.assertRaisesRegex(MODULE.ReloadError, "force"):
            MODULE.previous_exit(status)

    def test_stale_resource_version_is_atomic_patch_failure(self) -> None:
        runner = FakeKubectl(patch_code=409)
        with self.assertRaisesRegex(MODULE.ReloadError, "kubectl failed"):
            self.workflow(runner).run()
        patch = next(
            call for call in runner.calls if "--subresource=ephemeralcontainers" in call
        )
        operations = json.loads(patch[patch.index("--patch") + 1])
        self.assertEqual(operations[0]["path"], "/metadata/uid")
        self.assertEqual(operations[1]["path"], "/metadata/resourceVersion")

    def test_authoritative_config_mismatch_aborts_before_patch(self) -> None:
        runner = FakeKubectl(config="different: true\n")
        with self.assertRaisesRegex(MODULE.ReloadError, "ConfigMap hash"):
            self.workflow(runner).run()
        self.assertFalse(
            any("--subresource=ephemeralcontainers" in call for call in runner.calls)
        )

    def test_existing_ephemeral_list_is_tested_and_appended_without_replacement(
        self,
    ) -> None:
        existing = [
            {"name": "approved-debug", "image": "example/debug@sha256:" + "a" * 64}
        ]
        target = pod(ephemeral=existing)
        helper = MODULE.helper_spec(
            "tempo-ingester-term-0-23643a67", IMAGE, CONFIG_SHA256
        )
        operations = MODULE.append_ephemeral_patch(target, helper)
        self.assertEqual(
            operations[2],
            {"op": "test", "path": "/spec/ephemeralContainers", "value": existing},
        )
        self.assertEqual(operations[3]["op"], "add")
        self.assertEqual(operations[3]["path"], "/spec/ephemeralContainers/-")
        self.assertEqual(operations[3]["value"], helper)
        self.assertEqual(target["spec"]["ephemeralContainers"], existing)

    def test_missing_ephemeral_list_is_created_once(self) -> None:
        target = pod(omit_ephemeral=True)
        helper = MODULE.helper_spec(
            "tempo-ingester-term-0-23643a67", IMAGE, CONFIG_SHA256
        )
        operations = MODULE.append_ephemeral_patch(target, helper)
        self.assertEqual(operations[-1]["op"], "add")
        self.assertEqual(operations[-1]["path"], "/spec/ephemeralContainers")
        self.assertEqual(operations[-1]["value"], [helper])

    def test_existing_own_helper_refuses_blind_repeat(self) -> None:
        runner = FakeKubectl(
            existing_ephemeral=[{"name": "tempo-ingester-term-0-olduid"}]
        )
        with self.assertRaisesRegex(MODULE.ReloadError, "blind repeat"):
            self.workflow(runner).run()
        self.assertFalse(
            any("--subresource=ephemeralcontainers" in call for call in runner.calls)
        )

    def test_helper_checks_process_and_projected_hash_then_one_term(self) -> None:
        script = MODULE.helper_script(CONFIG_SHA256)
        self.assertIn("/proc/1/cmdline", script)
        self.assertIn("/tempo ", script)
        self.assertIn("-target=ingester", script)
        self.assertIn("-config.file=/conf/tempo.yaml", script)
        self.assertIn("sha256sum /proc/1/root/conf/tempo.yaml", script)
        self.assertEqual(script.count("kill -0 1"), 1)
        self.assertEqual(script.count("kill -TERM 1"), 1)
        self.assertNotIn("kill -9", script)
        self.assertNotIn("kill -KILL", script)
        self.assertNotIn("SIGKILL", script)

    def test_log_redaction_covers_json_and_url_credentials(self) -> None:
        redacted = MODULE.redact_text(
            '{"secret_key":"private-value","Authorization": "Bearer private-token"} '
            "https://user:password@example.invalid/path"
        )
        self.assertNotIn("private-value", redacted)
        self.assertNotIn("private-token", redacted)
        self.assertNotIn("user:password@", redacted)

    def test_wrong_process_guard_is_strict(self) -> None:
        script = MODULE.helper_script(CONFIG_SHA256)
        self.assertIn(
            '"/tempo "*"-target=ingester"*"-config.file=/conf/tempo.yaml"*)', script
        )
        self.assertNotIn("*tempo*", script)

    def test_execute_requires_exact_cluster_and_approved_image(self) -> None:
        with self.assertRaisesRegex(MODULE.ReloadError, "galactic-lan"):
            self.workflow(FakeKubectl(), context="other-cluster").run()
        with self.assertRaisesRegex(MODULE.ReloadError, "approved busybox"):
            self.workflow(
                FakeKubectl(), utility_image="registry.example/debug@sha256:" + "b" * 64
            ).run()

    def test_ring_parser_returns_only_active_rows(self) -> None:
        page = """
        <table><tr><th>Instance ID</th><th>Zone</th><th>State</th><th>Address</th>
        <th>Registered At</th><th>Read-Only</th><th>Read-Only Updated</th><th>Last Heartbeat</th></tr>
        <tr><td>observability-tempo-ingester-0</td><td></td><td>ACTIVE</td><td>10.244.0.1:9095</td>
        <td></td><td></td><td></td><td>1s ago (11:22:22)</td></tr>
        <tr><td>observability-tempo-ingester-1</td><td></td><td>ACTIVE</td><td>10.244.0.2:9095</td>
        <td></td><td></td><td></td><td>4s ago (11:22:20)</td></tr>
        <tr><td>observability-tempo-ingester-2</td><td></td><td>JOINING</td><td>10.244.0.3:9095</td>
        <td></td><td></td><td></td><td>1s ago (11:22:22)</td></tr>
        </table>
        """
        parsed = MODULE.parse_ring_page(page)
        self.assertEqual(
            parsed.active_ids,
            ("observability-tempo-ingester-0", "observability-tempo-ingester-1"),
        )
        self.assertEqual(parsed.fresh_active_ids, parsed.active_ids)
        self.assertEqual(
            parsed.active_addresses[0],
            ("observability-tempo-ingester-0", "10.244.0.1:9095"),
        )

    def test_ring_gate_rejects_stale_heartbeat(self) -> None:
        stale = MODULE.RingSnapshot(
            ring().active_ids,
            ("observability-tempo-ingester-0", "observability-tempo-ingester-1"),
            ring().active_addresses,
        )
        with self.assertRaisesRegex(MODULE.ReloadError, "stale"):
            MODULE.validate_ring(
                stale,
                ring().active_ids,
                {
                    name: f"10.244.0.{index + 1}"
                    for index, name in enumerate(ring().active_ids)
                },
            )

    def test_source_has_no_pod_delete_or_forced_signal_operation(self) -> None:
        source = (
            Path(__file__)
            .with_name("tempo-ingester-reload.py")
            .read_text(encoding="utf-8")
        )
        self.assertNotIn("kubectl delete", source)
        self.assertNotIn("kubectl apply", source)
        self.assertNotIn("kill -9", source)
        self.assertNotIn("SIGKILL", source)


if __name__ == "__main__":
    unittest.main()

import copy
import hashlib
import json
import io
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path("argocd/applications/temporal/upgrade/elasticsearch-snapshot.py")
spec = importlib.util.spec_from_file_location("snapshot", path)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class Fixture:
    def __init__(self):
        self.calls = []
        self.root = {
            "cluster_uuid": snapshot.CLUSTER_UUID,
            "version": {"number": "8.5.1"},
        }
        self.health = {
            "status": "green",
            "timed_out": False,
            "number_of_nodes": 3,
            "unassigned_shards": 0,
            "initializing_shards": 0,
            "relocating_shards": 0,
        }
        self.nodes = {
            "_nodes": {"failed": 0},
            "nodes": {
                key: {
                    "name": name,
                    "version": "8.5.1",
                    "settings": {
                        "s3": {
                            "client": {
                                snapshot.CLIENT: {
                                    "endpoint": snapshot.ENDPOINT,
                                    "protocol": "http",
                                    "path_style_access": "true",
                                    "region": "us-east-1",
                                }
                            }
                        }
                    },
                }
                for key, name in snapshot.NODES.items()
            },
        }
        self.repository = None
        self.original = {
            "temporal_visibility_v1_dev": "original-visibility",
            ".hidden": "original-hidden",
        }
        self.snapshot = None
        self.after_snapshot_indices = None
        self.result = {
            "snapshot": snapshot.SNAPSHOT,
            "uuid": "snapshot-uuid",
            "state": "SUCCESS",
            "version": "8.5.1",
            "include_global_state": True,
            "metadata": {
                "generation": snapshot.GENERATION,
                "repository_analysis_issues": [],
                "cluster_uuid": snapshot.CLUSTER_UUID,
                "indices_sha256": hashlib.sha256(
                    json.dumps(
                        self.original, sort_keys=True, separators=(",", ":")
                    ).encode()
                ).hexdigest(),
            },
            "indices": list(self.original),
            "failures": [],
            "shards": {"failed": 0, "successful": 2, "total": 2},
        }
        self.issues = []
        self.verify_nodes = {
            key: {"name": name} for key, name in snapshot.NODES.items()
        }

    def api(self, method, path, body=None, missing=False):
        self.calls.append((method, path, copy.deepcopy(body)))
        route = path.split("?")[0]
        repo = "/_snapshot/" + snapshot.REPOSITORY
        if method == "GET" and route == "/":
            return copy.deepcopy(self.root)
        if route == "/_cluster/health":
            return copy.deepcopy(self.health)
        if route == "/_nodes/settings":
            return copy.deepcopy(self.nodes)
        if route == "/_cat/indices":
            return [
                {"index": key, "uuid": value} for key, value in self.original.items()
            ]
        if route == repo:
            if method == "PUT":
                self.repository = {snapshot.REPOSITORY: copy.deepcopy(body)}
                return {"acknowledged": True}
            return copy.deepcopy(self.repository)
        if route == repo + "/_verify":
            return {"nodes": copy.deepcopy(self.verify_nodes)}
        if route == repo + "/_analyze":
            return {"repository": snapshot.REPOSITORY, "issues_detected": self.issues}
        if route == repo + "/" + snapshot.SNAPSHOT:
            if method == "PUT":
                self.snapshot = copy.deepcopy(self.result)
                if self.after_snapshot_indices is not None:
                    self.original = copy.deepcopy(self.after_snapshot_indices)
                return {"snapshot": copy.deepcopy(self.result)}
            return (
                None
                if self.snapshot is None
                else {"snapshots": [copy.deepcopy(self.snapshot)]}
            )
        raise AssertionError((method, path))


class SnapshotTests(unittest.TestCase):
    def test_rollout_waits_for_three_stable_nodes_without_repository_writes(self):
        fixture = Fixture()
        fixture.health["number_of_nodes"] = 2
        sleeps = []

        def finish_rollout(seconds):
            sleeps.append(seconds)
            fixture.health["number_of_nodes"] = 3

        snapshot.wait_for_source(fixture.api, sleep=finish_rollout, clock=lambda: 0)
        self.assertEqual(sleeps, [5])
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))
        self.assertIsNone(fixture.repository)

    def test_waits_for_old_nodes_to_load_the_s3_configuration(self):
        fixture = Fixture()
        first = next(iter(fixture.nodes["nodes"].values()))
        settings = first.pop("settings")
        snapshot.wait_for_source(
            fixture.api,
            sleep=lambda _: first.update(settings=settings),
            clock=lambda: 0,
        )
        self.assertIsNone(fixture.repository)

    def test_permanent_unreadiness_exhausts_the_wait_without_writes(self):
        fixture = Fixture()
        fixture.health["number_of_nodes"] = 2
        with self.assertRaises(snapshot.SourceNotReady):
            snapshot.capture(
                fixture.api, bucket=snapshot.EXPECTED_BUCKET, ready_timeout=0
            )
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))

    def test_foreign_identity_is_not_treated_as_a_rollout_delay(self):
        fixture = Fixture()
        fixture.root["cluster_uuid"] = "foreign"
        sleeps = []
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            snapshot.wait_for_source(fixture.api, sleep=sleeps.append)
        self.assertEqual(sleeps, [])
        self.assertIsNone(fixture.repository)

    def test_bucket_claim_must_resolve_to_the_selected_store(self):
        binding = {
            "BUCKET_NAME": snapshot.EXPECTED_BUCKET,
            "BUCKET_HOST": snapshot.CLAIM_HOST,
            "BUCKET_PORT": "80",
        }
        self.assertEqual(
            snapshot.require_bucket_binding(binding), binding["BUCKET_NAME"]
        )
        for key in binding:
            for value in ("", "foreign"):
                with (
                    self.subTest(key=key, value=value),
                    self.assertRaises(RuntimeError),
                ):
                    snapshot.require_bucket_binding(dict(binding, **{key: value}))

    def test_native_snapshot_freezes_repository_before_receipt(self):
        fixture = Fixture()
        proof = snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertTrue(proof["repositoryReadOnly"])
        self.assertTrue(fixture.repository[snapshot.REPOSITORY]["settings"]["readonly"])
        self.assertEqual(
            fixture.calls[-1][:2], ("GET", "/_snapshot/" + snapshot.REPOSITORY)
        )

    def test_failed_repository_freeze_cannot_produce_receipt(self):
        fixture = Fixture()
        original = fixture.api

        def failed_freeze(method, path, body=None, missing=False):
            if method == "PUT" and body and body.get("settings", {}).get("readonly"):
                return {"acknowledged": False}
            return original(method, path, body, missing)

        with self.assertRaisesRegex(RuntimeError, "freeze was not acknowledged"):
            snapshot.capture(failed_freeze, bucket=snapshot.EXPECTED_BUCKET)

    def test_readback_failure_after_freeze_recovers_without_writes(self):
        fixture = Fixture()
        original = fixture.api

        def failed_readback(method, path, body=None, missing=False):
            if (
                method == "GET"
                and path == "/_snapshot/" + snapshot.REPOSITORY
                and fixture.repository
                and fixture.repository[snapshot.REPOSITORY]["settings"].get("readonly")
            ):
                raise RuntimeError("lost freeze readback response")
            return original(method, path, body, missing)

        with self.assertRaisesRegex(RuntimeError, "lost freeze readback"):
            snapshot.capture(failed_readback, bucket=snapshot.EXPECTED_BUCKET)
        self.assertTrue(fixture.repository[snapshot.REPOSITORY]["settings"]["readonly"])
        fixture.calls.clear()
        proof = snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertTrue(proof["repositoryReadOnly"])
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))

    def test_frozen_snapshot_requires_recorded_native_analysis(self):
        fixture = Fixture()
        snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        del fixture.snapshot["metadata"]["repository_analysis_issues"]
        fixture.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "native repository analysis record"):
            snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))

    def test_unexpected_bucket_stops_before_any_elasticsearch_request(self):
        fixture = Fixture()
        with self.assertRaisesRegex(RuntimeError, "unexpected snapshot bucket"):
            snapshot.capture(fixture.api, bucket="temporal-elasticsearch-sna-foreign")
        self.assertEqual(fixture.calls, [])

    def test_requests_share_the_job_deadline_budget(self):
        with (
            patch.object(snapshot, "REQUEST_DEADLINE", 3600),
            patch.object(snapshot.time, "monotonic", side_effect=[100, 2200]),
            patch.object(
                snapshot, "urlopen", side_effect=[io.BytesIO(b"{}"), io.BytesIO(b"{}")]
            ) as opened,
        ):
            snapshot.request(
                "PUT", "/_snapshot/repository/snapshot?wait_for_completion=true", {}
            )
            snapshot.request("GET", "/_snapshot/repository/snapshot")
        self.assertEqual(
            [call.kwargs["timeout"] for call in opened.call_args_list], [3500, 1400]
        )

    def test_expired_job_budget_prevents_another_request(self):
        with (
            patch.object(snapshot, "REQUEST_DEADLINE", 3600),
            patch.object(snapshot.time, "monotonic", return_value=3601),
            patch.object(snapshot, "urlopen") as opened,
        ):
            with self.assertRaisesRegex(RuntimeError, "time budget exhausted"):
                snapshot.request("PUT", "/_snapshot/repository/snapshot", {})
        opened.assert_not_called()

    def test_native_snapshot_retains_hidden_indices_and_global_state(self):
        fixture = Fixture()
        proof = snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertEqual(proof["status"], "NATIVE_SNAPSHOT_PASS_RESTORE_PENDING")
        self.assertEqual(proof["originalIndexUUIDs"], fixture.original)
        create = next(
            body
            for method, path, body in fixture.calls
            if method == "PUT" and "wait_for_completion" in path
        )
        self.assertTrue(create["include_global_state"])
        self.assertFalse(create["partial"])
        self.assertNotIn("indices", create)

    def test_index_identity_changes_during_snapshot_cannot_produce_a_receipt(self):
        for change in ("recreated", "removed", "added"):
            with self.subTest(change=change):
                fixture = Fixture()
                final = copy.deepcopy(fixture.original)
                if change == "recreated":
                    final["temporal_visibility_v1_dev"] = "replacement-uuid"
                elif change == "removed":
                    del final[".hidden"]
                else:
                    final["new-index"] = "new-uuid"
                fixture.after_snapshot_indices = final
                with self.assertRaisesRegex(RuntimeError, "identities changed while"):
                    snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
                self.assertTrue(
                    any(
                        method == "PUT" and "wait_for_completion" in path
                        for method, path, _ in fixture.calls
                    )
                )

    def test_transient_extra_snapshot_index_is_rejected_even_if_live_map_recovers(self):
        fixture = Fixture()
        fixture.result["indices"].append("temporary-unrecorded-index")
        with self.assertRaisesRegex(RuntimeError, "snapshot index set differs"):
            snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertEqual(
            fixture.original,
            {
                "temporal_visibility_v1_dev": "original-visibility",
                ".hidden": "original-hidden",
            },
        )
        self.assertTrue(
            any(
                method == "PUT" and "wait_for_completion" in path
                for method, path, _ in fixture.calls
            )
        )

    def test_source_identity_failures_prevent_all_mutations(self):
        for failure in [
            "uuid",
            "version",
            "missing_node",
            "node_identity",
            "node_version",
            "s3_endpoint",
            "red",
            "relocating",
        ]:
            with self.subTest(failure=failure):
                fixture = Fixture()
                first = next(iter(fixture.nodes["nodes"].values()))
                if failure == "uuid":
                    fixture.root["cluster_uuid"] = "foreign"
                if failure == "version":
                    fixture.root["version"]["number"] = "8.19.21"
                if failure == "missing_node":
                    fixture.nodes["nodes"].pop(next(iter(fixture.nodes["nodes"])))
                if failure == "node_identity":
                    first["name"] = "foreign"
                if failure == "node_version":
                    first["version"] = "8.19.21"
                if failure == "s3_endpoint":
                    first["settings"]["s3"]["client"][snapshot.CLIENT]["endpoint"] = (
                        "foreign"
                    )
                if failure == "red":
                    fixture.health["status"] = "red"
                if failure == "relocating":
                    fixture.health["relocating_shards"] = 1
                with self.assertRaises(RuntimeError):
                    snapshot.capture(
                        fixture.api, bucket=snapshot.EXPECTED_BUCKET, ready_timeout=0
                    )
                self.assertFalse(any(method != "GET" for method, _, _ in fixture.calls))

    def test_never_overwrites_foreign_repository(self):
        fixture = Fixture()
        fixture.repository = {
            snapshot.REPOSITORY: {"type": "fs", "settings": {"location": "/foreign"}}
        }
        with self.assertRaisesRegex(RuntimeError, "different type or destination"):
            snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertFalse(any(method == "PUT" for method, _, _ in fixture.calls))

    def test_requires_shared_access_and_clean_analysis(self):
        for failure in ["missing_node", "issues"]:
            with self.subTest(failure=failure):
                fixture = Fixture()
                if failure == "missing_node":
                    fixture.verify_nodes.pop(next(iter(fixture.verify_nodes)))
                else:
                    fixture.issues = ["incorrect read"]
                with self.assertRaises(RuntimeError):
                    snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
                self.assertFalse(
                    any(
                        method == "PUT" and "wait_for_completion" in path
                        for method, path, _ in fixture.calls
                    )
                )

    def test_existing_native_backup_is_idempotent(self):
        fixture = Fixture()
        fixture.snapshot = copy.deepcopy(fixture.result)
        snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
        self.assertFalse(
            any(
                method == "PUT" and "wait_for_completion" in path
                for method, path, _ in fixture.calls
            )
        )

    def test_rejects_invalid_existing_backup_without_replacing_it(self):
        for failure in [
            "partial",
            "failed_shard",
            "missing_index",
            "wrong_index",
            "wrong_generation",
            "wrong_cluster",
            "wrong_version",
            "no_global_state",
        ]:
            with self.subTest(failure=failure):
                fixture = Fixture()
                existing = fixture.snapshot = copy.deepcopy(fixture.result)
                if failure == "partial":
                    existing["state"] = "PARTIAL"
                if failure == "failed_shard":
                    existing["shards"]["failed"] = 1
                if failure == "missing_index":
                    existing["indices"].remove(".hidden")
                if failure == "wrong_index":
                    existing["metadata"]["indices_sha256"] = "new-index"
                if failure == "wrong_generation":
                    existing["metadata"]["generation"] = "wrong"
                if failure == "wrong_cluster":
                    existing["metadata"]["cluster_uuid"] = "wrong"
                if failure == "wrong_version":
                    existing["version"] = "8.19.21"
                if failure == "no_global_state":
                    existing["include_global_state"] = False
                with self.assertRaises(RuntimeError):
                    snapshot.capture(fixture.api, bucket=snapshot.EXPECTED_BUCKET)
                self.assertFalse(
                    any(
                        method == "PUT" and "wait_for_completion" in path
                        for method, path, _ in fixture.calls
                    )
                )


if __name__ == "__main__":
    unittest.main()

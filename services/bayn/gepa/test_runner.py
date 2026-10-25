import copy
import tempfile
import unittest
from pathlib import Path

from runner import (
    Study,
    encode,
    identity,
    instructions,
    read_json,
    run_study,
    validate_study,
)


class MemoryStorage:
    def __init__(self):
        self.objects = {}

    def read(self, key):
        return copy.deepcopy(self.objects.get(key))

    def create(self, key, value):
        if key in self.objects:
            return False
        self.objects[key] = copy.deepcopy(value)
        return True


def fixture():
    baseline = {"entry": "Assess the supplied complete plans."}

    def task(name, date):
        return {
            "id": name,
            "input": {
                "jevInstructionsHash": identity(baseline),
                "build": {
                    "sourceRevision": "a" * 40,
                    "imageDigest": "sha256:" + "b" * 64,
                },
                "interval": {
                    "startAt": date + "T13:30:00.000Z",
                    "endAt": date + "T20:00:00.000Z",
                },
                "inference": {"maximumCalls": 2},
            },
            "arrivalsPath": "/private/source.ndjson.gz",
            "sourceReceiptPath": "/private/source.json",
            "sourceReceiptSha256": "c" * 64,
            "operatingAllocations": [],
        }

    return {
        "schemaVersion": "bayn.jev-gepa-study.v1",
        "sourceRevision": "a" * 40,
        "imageRepository": "registry.ide-newton.ts.net/lab/bayn",
        "imageDigest": "sha256:" + "b" * 64,
        "baseline": baseline,
        "editor": {"policy": {}, "costBasis": None},
        "maximumSearchEvaluations": 4,
        "maximumEditorCalls": 1,
        "maximumNativeCalls": 20,
        "maximumWallSeconds": 60,
        "seed": 7,
        "development": [task("development", "2026-09-10")],
        "evaluation": [task("hidden-evaluation", "2026-09-11")],
    }


class NativeBoundary:
    def __init__(self):
        self.calls = []

    def __call__(self, command, directory, _timeout):
        self.calls.append(command)
        if command[0] == "bayn-research":
            run = read_json(command[2])
            assert "hidden-evaluation" not in run["promptTemplate"]
            receipt = {
                "outcome": "COMPLETE",
                "instructions": {"entry": "Choose the shorter supported plan."},
            }
            Path(command[4]).write_bytes(encode(receipt))
        else:
            request = read_json(command[2])
            document = request["instructions"]
            pnl = "-2000000" if "shorter" in document["entry"] else "-5000000"
            output = directory / "result"
            output.mkdir()
            (output / "outcome.json").write_bytes(
                encode(
                    {
                        "knownNetPnlMicros": pnl,
                        "remainingPositions": 0,
                        "unresolvedModelCalls": 0,
                        "reportHash": identity(request),
                        "contextHash": "d" * 64,
                        "instructionsHash": identity(document),
                        "costCoverage": "KNOWN_COSTS_ONLY",
                        "issues": ["unresolved-data-cost"],
                        "providerRequests": 2,
                        "executionPnlMicros": pnl,
                        "knownModelCostMicros": "0",
                        "conservativeMaximumDrawdownMicros": None,
                    }
                )
            )


class GepaIntegrationTests(unittest.TestCase):
    def test_real_upstream_search_uses_native_metric_and_hides_evaluation_feedback(
        self,
    ):
        storage, native = MemoryStorage(), NativeBoundary()
        with tempfile.TemporaryDirectory() as directory:
            result = run_study(
                fixture(),
                directory,
                storage,
                "/checkout",
                "/dependencies",
                native,
                lambda: 1000,
            )
            self.assertTrue(result["distinctCandidate"])
            self.assertIn("shorter", result["selected"]["entry"])
            self.assertEqual(result["pairs"][0]["knownNetDeltaMicros"], "3000000")
            self.assertEqual(result["economicImprovement"], "UNPROVEN")
            self.assertEqual(
                result["pairs"][0]["candidate"]["costCoverage"], "KNOWN_COSTS_ONLY"
            )
            calls = len(native.calls)
            self.assertEqual(
                run_study(
                    fixture(), directory, storage, "/checkout", "/dependencies", native
                ),
                result,
            )
            self.assertEqual(len(native.calls), calls)

    def test_native_reservations_bound_search_test_repeat_and_failed_attempts(self):
        study = fixture()
        study["maximumNativeCalls"] = 2
        storage, native = MemoryStorage(), NativeBoundary()
        with tempfile.TemporaryDirectory() as directory:
            adapter = Study(
                study,
                directory,
                storage,
                "/checkout",
                "/dependencies",
                native,
                lambda: 1000,
            )
            task = study["development"][0]
            adapter.evaluate(encode(study["baseline"]).decode(), task)
            adapter.evaluate(encode(study["baseline"]).decode(), task)
            self.assertEqual(len(native.calls), 1)
            with self.assertRaisesRegex(ValueError, "total native-call budget"):
                adapter.evaluate(
                    encode(study["baseline"]).decode(), task, replicate="repeat"
                )

    def test_ambiguous_native_work_is_never_retransmitted(self):
        calls = []

        def interrupted(command, _directory, _timeout):
            calls.append(command)
            raise RuntimeError("interrupted native provider dispatch")

        study, storage = fixture(), MemoryStorage()
        with tempfile.TemporaryDirectory() as directory:
            adapter = Study(
                study,
                directory,
                storage,
                "/checkout",
                "/dependencies",
                interrupted,
                lambda: 1000,
            )
            with self.assertRaises(RuntimeError):
                adapter.evaluate(
                    encode(study["baseline"]).decode(), study["development"][0]
                )
            with self.assertRaisesRegex(ValueError, "cannot be retransmitted"):
                adapter.evaluate(
                    encode(study["baseline"]).decode(), study["development"][0]
                )
            self.assertEqual(len(calls), 1)

    def test_execution_failures_do_not_become_fitness(self):
        native = NativeBoundary()

        def invalid(command, directory, timeout):
            native(command, directory, timeout)
            path = directory / "result/outcome.json"
            result = read_json(path)
            result["issues"] = ["inexact-accounting"]
            path.write_bytes(encode(result))

        study = fixture()
        with tempfile.TemporaryDirectory() as directory:
            adapter = Study(
                study,
                directory,
                MemoryStorage(),
                "/checkout",
                "/dependencies",
                invalid,
                lambda: 1000,
            )
            with self.assertRaisesRegex(ValueError, "failure cannot supply fitness"):
                adapter.evaluate(
                    encode(study["baseline"]).decode(), study["development"][0]
                )

    def test_retired_studies_and_arbitrary_instruction_fields_are_rejected(self):
        for document in (
            {"entry": ""},
            {"entry": " "},
            {"entry": "a" * 2001},
            {"entry": "x", "code": "run"},
        ):
            with self.assertRaises(ValueError):
                instructions(document)
        study = fixture()
        study["schemaVersion"] = "bayn.jev-harness2-study.v1"
        with self.assertRaises(ValueError):
            validate_study(study)

    def test_known_cost_fitness_keeps_negative_net_and_unknown_coverage(self):
        native = NativeBoundary()

        def with_partial_costs(command, directory, timeout):
            native(command, directory, timeout)
            path = directory / "result/outcome.json"
            outcome = read_json(path)
            outcome["executionPnlMicros"] = "9969985"
            outcome["knownNetPnlMicros"] = "-990030015"
            outcome["costCoverage"] = "KNOWN_COSTS_ONLY"
            path.write_bytes(encode(outcome))

        study = fixture()
        storage = MemoryStorage()
        with tempfile.TemporaryDirectory() as directory:
            adapter = Study(
                study,
                directory,
                storage,
                "/checkout",
                "/dependencies",
                with_partial_costs,
                lambda: 1000,
            )
            score, feedback = adapter.evaluate(
                encode(study["baseline"]).decode(), study["development"][0]
            )
            self.assertEqual(score, -990.030015)
            self.assertEqual(feedback["knownNetPnlMicros"], "-990030015")
            self.assertEqual(feedback["executionPnlMicros"], "9969985")
            self.assertEqual(feedback["costCoverage"], "KNOWN_COSTS_ONLY")
            self.assertIsNone(feedback["conservativeMaximumDrawdownMicros"])
            retained = storage.read("receipts/0.json")
            self.assertEqual(retained, {"score": score, "feedback": feedback})

    def test_temporal_overlap_source_mutation_and_unknown_fields_are_rejected(self):
        for mutate in (
            lambda s: s["evaluation"][0]["input"]["interval"].update(
                startAt="2026-09-10T14:00:00.000Z"
            ),
            lambda s: s["development"][0]["input"]["build"].update(
                sourceRevision="0" * 40
            ),
            lambda s: s.update(unfrozenPolicy=True),
        ):
            study = fixture()
            mutate(study)
            with self.assertRaises(ValueError):
                validate_study(study)


if __name__ == "__main__":
    unittest.main()

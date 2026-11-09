import io
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
import sys
import tempfile
import tomllib
import types
import unittest
from unittest.mock import patch

import cosmosalpha_experiment as experiment


class ClientError(Exception):
    pass


@dataclass
class HttpResponse:
    status_code: int
    body: str
    headers: dict


class Response:
    status = 200

    def __init__(self, body, model_identity):
        self.body = json.dumps(body).encode()
        self.headers = {"x-model-serving-identity": json.dumps(model_identity)}

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class BudgetTests(unittest.TestCase):
    def test_invalid_limits(self):
        for value in [0, -1, True, 1.5]:
            with self.assertRaises(ValueError):
                experiment.Limits(physical_requests=value)
        with self.assertRaises(ValueError):
            experiment.Limits(evaluable_factors=2, proposal_slots=1)

    def test_failed_cycles_do_not_refund_proposal_allowance(self):
        budget = experiment.ArmBudget(
            experiment.Limits(proposal_slots=4, evaluable_factors=4)
        )
        budget.proposal(2)
        budget.proposal(2)
        with self.assertRaises(experiment.BudgetReached):
            budget.proposal(1)
        self.assertEqual(budget.summary()["requestedProposalSlots"], 4)

    def test_concurrent_requests_reserve_tokens_before_network(self):
        budget = experiment.ArmBudget(experiment.Limits(completion_tokens=40_000))

        def reserve(_):
            try:
                return budget.reserve_request(20_000)
            except experiment.BudgetReached:
                return None

        with ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(reserve, range(32)))
        self.assertEqual(sorted(x for x in results if x), [1, 2])
        self.assertEqual(budget.summary()["heldCompletionTokens"], 40_000)
        budget.settle(20_000, {"completion_tokens": 5, "prompt_tokens": 0})
        budget.settle(20_000, {"completion_tokens": 7, "prompt_tokens": 0})
        self.assertEqual(budget.summary()["completionTokens"], 12)
        self.assertEqual(budget.summary()["heldCompletionTokens"], 0)

    def test_unknown_outcome_blocks_retry(self):
        budget = experiment.ArmBudget(experiment.Limits())
        budget.reserve_request(20_000)
        budget.settle(20_000, None)
        with self.assertRaisesRegex(experiment.BudgetReached, "unknown"):
            budget.reserve_request(20_000)
        self.assertEqual(budget.summary()["physicalRequests"], 1)

    def test_physical_calls_have_a_separate_ceiling(self):
        budget = experiment.ArmBudget(experiment.Limits(physical_requests=1))
        budget.reserve_request(10)
        budget.settle(10, {"completion_tokens": 1, "prompt_tokens": 0})
        with self.assertRaisesRegex(experiment.BudgetReached, "physical-request"):
            budget.reserve_request(10)

    def test_output_target_prevents_new_proposal_cycles(self):
        budget = experiment.ArmBudget(experiment.Limits(evaluable_factors=1))
        budget.evaluable["factor"] = object()
        with self.assertRaisesRegex(experiment.BudgetReached, "evaluable"):
            budget.proposal(1)
        self.assertEqual(budget.slots, 0)

    def test_concurrent_evaluation_capacity_cannot_overshoot_the_output_target(self):
        budget = experiment.ArmBudget(experiment.Limits(evaluable_factors=2))

        def start(key):
            try:
                budget.start_evaluation(key)
                return key
            except experiment.BudgetReached:
                return None

        with ThreadPoolExecutor(max_workers=8) as workers:
            admitted = [key for key in workers.map(start, range(40)) if key is not None]
        self.assertEqual(len(admitted), 2)
        for key in admitted:
            budget.finish_evaluation(key, object(), True)
        self.assertEqual(budget.summary()["evaluableFactors"], 2)
        self.assertEqual(budget.summary()["pendingEvaluations"], 0)

    def test_failed_evaluation_releases_output_capacity_and_retains_the_attempt(self):
        budget = experiment.ArmBudget(experiment.Limits(evaluable_factors=1))
        budget.start_evaluation("bad")
        budget.finish_evaluation("bad", None, False)
        budget.start_evaluation("good")
        budget.finish_evaluation("good", object(), True)
        self.assertEqual(budget.summary()["evaluationAttempts"], 2)
        self.assertEqual(budget.summary()["completedEvaluations"], 1)


class AuxiliaryResponseTests(unittest.TestCase):
    def test_target_stops_new_expansions_and_allows_final_cycle_feedback(self):
        budget = experiment.ArmBudget(experiment.Limits(evaluable_factors=1))
        budget.evaluable["complete"] = object()
        delegate = unittest.mock.Mock()
        delegate.complete.return_value = types.SimpleNamespace(
            content='{"suggestions":["fixture"]}'
        )
        client = experiment.CheckedModelClient(delegate, budget)
        feedback = types.SimpleNamespace(
            prompt=types.SimpleNamespace(prompt_id="factor_feedback")
        )
        self.assertIs(client.complete(feedback), delegate.complete.return_value)
        delegate.complete.reset_mock()
        request = types.SimpleNamespace(
            prompt=types.SimpleNamespace(prompt_id="suggestion")
        )
        with self.assertRaises(experiment.EvaluableTargetReached):
            client.complete(request)
        delegate.complete.assert_not_called()
        self.assertEqual(budget.summary()["failedAuxiliaryResponses"], 0)

    def test_empty_truncated_or_malformed_auxiliary_responses_are_retained_as_failures(
        self,
    ):
        for purpose, content in [
            ("suggestion", ""),
            ("suggestion", '{"suggestions": []}'),
            ("suggestion", '{"suggestions": [7]}'),
            ("portrait", '{"expression": "close"}'),
        ]:
            with self.subTest(purpose=purpose, content=content):
                budget = experiment.ArmBudget(experiment.Limits())
                delegate = unittest.mock.Mock()
                delegate.complete.return_value = types.SimpleNamespace(content=content)
                client = experiment.CheckedModelClient(delegate, budget)
                request = types.SimpleNamespace(
                    prompt=types.SimpleNamespace(prompt_id=purpose)
                )
                with self.assertRaisesRegex(ValueError, "Unusable MCTS"):
                    client.complete(request)
                self.assertEqual(budget.summary()["failedAuxiliaryResponses"], 1)
                self.assertEqual(budget.summary()["successfulAuxiliaryResponses"], 0)
                with self.assertRaisesRegex(experiment.BudgetReached, "auxiliary"):
                    budget.reserve_request(100)
                with self.assertRaisesRegex(experiment.BudgetReached, "auxiliary"):
                    budget.proposal(1)

    def test_usable_auxiliary_content_is_counted_without_modifying_it(self):
        for purpose, value in [
            ("suggestion", {"suggestions": ["Normalize close."]}),
            (
                "portrait",
                {
                    key: "fixture"
                    for key in [
                        "portrait_name",
                        "portrait_logic",
                        "portrait_pseudocode",
                        "expression",
                    ]
                },
            ),
        ]:
            with self.subTest(purpose=purpose):
                budget = experiment.ArmBudget(experiment.Limits())
                delegate = unittest.mock.Mock()
                response = types.SimpleNamespace(content=json.dumps(value))
                delegate.complete.return_value = response
                client = experiment.CheckedModelClient(delegate, budget)
                request = types.SimpleNamespace(
                    prompt=types.SimpleNamespace(prompt_id=purpose)
                )
                self.assertIs(client.complete(request), response)
                self.assertEqual(budget.summary()["successfulAuxiliaryResponses"], 1)
                self.assertEqual(budget.summary()["failedAuxiliaryResponses"], 0)

    def test_auxiliary_client_errors_cannot_be_hidden_by_native_fallbacks(self):
        budget = experiment.ArmBudget(experiment.Limits())
        delegate = unittest.mock.Mock()
        delegate.complete.side_effect = TimeoutError("Retain this auxiliary failure")
        client = experiment.CheckedModelClient(delegate, budget)
        request = types.SimpleNamespace(
            prompt=types.SimpleNamespace(prompt_id="suggestion")
        )
        with self.assertRaises(TimeoutError):
            client.complete(request)
        self.assertEqual(budget.summary()["failedAuxiliaryResponses"], 1)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.identity = {"model": experiment.MODEL, "checkpoint": "a" * 40}
        self.journal = io.StringIO()
        self.budget = experiment.ArmBudget(experiment.Limits())
        self.transport = experiment.FlamingoTransport(
            self.budget, 123, self.identity, self.journal
        )
        self.payload = {
            "model": experiment.MODEL,
            "max_tokens": 100,
            "messages": [{"role": "user", "content": "Fixture"}],
            "reasoning_effort": "max",
        }
        modules = {
            "cosmosalpha.llm.errors": types.SimpleNamespace(LLMClientError=ClientError),
            "cosmosalpha.llm.openai_compatible": types.SimpleNamespace(
                JsonHttpResponse=HttpResponse
            ),
        }
        self.module_patch = patch.dict(sys.modules, modules)
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)

    def response(self, **changes):
        value = {
            "model": experiment.MODEL,
            "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
            **changes,
        }
        return Response(value, self.identity)

    def call(self):
        return self.transport.post_json(
            experiment.ENDPOINT + "/chat/completions",
            {"Authorization": "Bearer do-not-send"},
            self.payload,
            10,
        )

    def test_actual_wire_profile_and_authorization(self):
        with patch.object(
            self.transport.opener, "open", return_value=self.response()
        ) as send:
            response = self.call()
        self.assertEqual(response.status_code, 200)
        request = send.call_args.args[0]
        self.assertNotIn("Authorization", request.headers)
        body = json.loads(request.data)
        self.assertEqual(body["seed"], 123)
        self.assertEqual(body["max_tokens"], 100)
        self.assertNotIn("reasoning_effort", body)
        for key, value in experiment.PROFILE.items():
            self.assertEqual(body[key], value)
        self.assertEqual(self.budget.summary()["completionTokens"], 3)

    def test_route_change_makes_no_request(self):
        with patch.object(self.transport.opener, "open") as send:
            with self.assertRaisesRegex(ClientError, "ROUTE"):
                self.transport.post_json(
                    "https://api.deepseek.com/chat/completions", {}, self.payload, 10
                )
        send.assert_not_called()
        self.assertEqual(self.budget.requests, 0)

    def test_empty_conversation_is_rejected_before_spending_a_physical_request(self):
        self.payload["messages"] = []
        with patch.object(self.transport.opener, "open") as send:
            with self.assertRaisesRegex(ClientError, "EMPTY_CONVERSATION"):
                self.call()
        send.assert_not_called()
        self.assertEqual(self.budget.requests, 0)
        self.assertEqual(self.budget.summary()["rejectedRequests"], 1)

    def test_redirect_cannot_change_the_frozen_destination(self):
        handler = experiment.NoRedirect()
        with self.assertRaisesRegex(ValueError, "redirect"):
            handler.redirect_request(
                None, None, 302, "redirect", {}, "https://elsewhere.invalid"
            )

    def test_usage_absence_halts_all_native_retries(self):
        with patch.object(
            self.transport.opener, "open", return_value=self.response(usage=None)
        ) as send:
            with self.assertRaises(ClientError):
                self.call()
            with self.assertRaises(ClientError):
                self.call()
        self.assertEqual(send.call_count, 1)
        self.assertEqual(self.budget.unknown_usage, 1)

    def test_serving_identity_drift_is_not_a_success(self):
        response = self.response()
        response.headers["x-model-serving-identity"] = json.dumps(
            {"model": experiment.MODEL, "checkpoint": "b" * 40}
        )
        with patch.object(self.transport.opener, "open", return_value=response):
            with self.assertRaises(ClientError):
                self.call()
        self.assertEqual(self.budget.unknown_usage, 1)

    def test_usage_above_submitted_limit_is_unknown(self):
        usage = {"prompt_tokens": 12, "completion_tokens": 101, "total_tokens": 113}
        with patch.object(
            self.transport.opener,
            "open",
            return_value=self.response(usage=usage),
        ):
            with self.assertRaises(ClientError):
                self.call()
        self.assertEqual(self.budget.unknown_usage, 1)


class ArtifactTests(unittest.TestCase):
    def test_provider_inventory_detects_quote_drift_even_outside_the_target_fields(
        self,
    ):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "provider" / "features" / "sh600176"
            source.mkdir(parents=True)
            quote = source / "factor.day.bin"
            quote.write_bytes(b"original quote-adjustment field")
            providers = {"market": str(root / "provider")}
            experiment.write_json(
                root / "providers.json", experiment.provider_inventory(providers)
            )
            plan = {
                "providerIdentityFile": "providers.json",
                "providerIdentitySha256": experiment.digest(root / "providers.json"),
                "providers": providers,
            }
            self.assertTrue(experiment.verify_provider_inventory(root, plan))
            quote.write_bytes(b"changed quote-adjustment field")
            with self.assertRaisesRegex(ValueError, "provider bytes drifted"):
                experiment.verify_provider_inventory(root, plan)

    def test_a_manifest_cannot_authenticate_arbitrary_code_by_claiming_the_author_commit(
        self,
    ):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "source"
            package.mkdir()
            (package / "unregistered.py").write_text("pass\n")
            manifest = root / "source.json"
            experiment.write_json(
                manifest,
                {
                    "sourceCommit": experiment.SOURCE_COMMIT,
                    "files": [
                        {
                            "path": "src/cosmosalpha/unregistered.py",
                            "sha256": experiment.digest(package / "unregistered.py"),
                        }
                    ],
                },
            )
            with self.assertRaisesRegex(ValueError, "registered repaired"):
                experiment.native_source(manifest, package)

    def test_toml_preserves_strict_native_numeric_types_and_field_arrays(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.toml"
            value = {
                "llm": {"temperature": 0.0, "max_output_tokens": 20000},
                "preprocessing": {"mad_multiplier": 5.0},
                "qlib": {
                    "market": {
                        "fields": [
                            {"field_name": "close", "expression": "$close"},
                            {"field_name": "open", "expression": "$open"},
                        ]
                    }
                },
            }
            experiment.write_toml(path, value)
            loaded = tomllib.loads(path.read_text())
            self.assertEqual(loaded, value)
            self.assertIs(type(loaded["llm"]["temperature"]), float)
            self.assertIs(type(loaded["llm"]["max_output_tokens"]), int)

    def test_result_cannot_overwrite_prior_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "result.json"
            experiment.write_json(path, {"status": "INCONCLUSIVE"})
            with self.assertRaises(FileExistsError):
                experiment.write_json(path, {"status": "COMPLETE"})
            self.assertEqual(json.loads(path.read_text())["status"], "INCONCLUSIVE")

    def test_resealed_incomplete_study_cannot_be_admitted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "plan.json"
            plan = {
                "schemaVersion": experiment.SCHEMA,
                "kind": "study",
                "runs": [],
                "implementation": [],
                "sourceIdentityFile": "source.json",
            }
            source = Path(temp) / "source.json"
            source.write_text("{}")
            plan["sourceIdentitySha256"] = experiment.digest(source)
            plan["experimentId"] = experiment.identity(plan)
            path.write_text(json.dumps(plan))
            with self.assertRaises(ValueError):
                experiment.load_plan(path)


class CoordinatorTests(unittest.TestCase):
    def _assert_failed_arms_retained(self, outage=None, auxiliary_failure=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "config.toml"
            config.write_text("fixture")
            plan = {
                "kind": "acceptance",
                "experimentId": "fixture",
                "targetId": "target",
                "runtimeVersions": {},
                "modelIdentity": {},
                "sourceIdentityFile": "source.json",
                "limits": experiment.asdict(experiment.limits_for("acceptance")),
                "runs": [
                    {
                        "runId": arm,
                        "arm": arm,
                        "seed": 123,
                        "config": config.name,
                        "sha256": experiment.digest(config),
                    }
                    for arm in experiment.ARMS
                ],
            }
            calls = []
            identity_calls = 0

            def live_model():
                nonlocal identity_calls
                identity_calls += 1
                if identity_calls == {"before": 1, "after": 2}.get(outage):
                    raise TimeoutError("Model identity service unavailable")
                return {}

            def run_arm(root, plan, run, budget, transport, output):
                calls.append(run["arm"])
                if run["arm"] == "mcts" and auxiliary_failure:
                    budget.auxiliary(
                        "suggestion", True, '{"suggestions":["fixture"]}', None
                    )
                    budget.auxiliary("suggestion", False, "", "ValueError")
                elif run["arm"] == "mcts" or (
                    outage == "after" and run["arm"] == "graph"
                ):
                    budget.proposal(2)
                    budget.reserve_request(100)
                    budget.settle(100, {"completion_tokens": 7, "prompt_tokens": 3})
                    raise ValueError("Retain this failed arm")
                budget.evaluable.update({str(i): object() for i in range(4)})
                budget.evaluation_completions = budget.evaluation_attempts = 4

            native = types.SimpleNamespace(
                run_arm=run_arm, downstream=unittest.mock.Mock()
            )
            modules = {
                "cosmosalpha": types.SimpleNamespace(
                    __file__="/virtual/cosmosalpha/__init__.py"
                ),
                "cosmosalpha_native_experiment": native,
            }
            with (
                patch.dict(sys.modules, modules),
                patch.object(experiment, "load_plan", return_value=(root, plan)),
                patch.object(experiment, "runtime_versions", return_value={}),
                patch.object(experiment, "live_model", side_effect=live_model),
                patch.object(experiment, "native_source", return_value={}),
                patch.object(
                    experiment, "verify_provider_inventory", return_value=True
                ),
                patch.object(experiment, "audit", return_value={"status": "FAIL"}),
                patch("sys.stdout", new_callable=io.StringIO),
            ):
                result = experiment.execute(root / "plan.json")
                expected_calls = list(experiment.ARMS)
                if outage == "before":
                    expected_calls.remove("graph")
                self.assertEqual(calls, expected_calls)
                self.assertEqual(result["status"], "INCONCLUSIVE")
                self.assertEqual(result["arms"][1]["status"], "INCONCLUSIVE")
                if auxiliary_failure:
                    self.assertIsNone(result["arms"][1]["failure"])
                    resources = result["arms"][1]["resources"]
                    self.assertEqual(resources["evaluableFactors"], 4)
                    self.assertEqual(resources["failedAuxiliaryResponses"], 1)
                    self.assertEqual(resources["successfulAuxiliaryResponses"], 1)
                else:
                    self.assertIn(
                        "Retain this failed arm",
                        result["arms"][1]["failure"]["message"],
                    )
                if outage:
                    graph = json.loads(
                        (root / "receipts/graph/result.json").read_text()
                    )
                    self.assertEqual(graph["status"], "INCONCLUSIVE")
                    if outage == "after":
                        self.assertEqual(graph["failure"]["type"], "ValueError")
                        self.assertEqual(
                            graph["identityVerificationFailure"]["type"], "TimeoutError"
                        )
                        self.assertEqual(
                            graph["resources"]["requestedProposalSlots"], 2
                        )
                        self.assertEqual(graph["resources"]["physicalRequests"], 1)
                        self.assertEqual(graph["resources"]["completionTokens"], 7)
                    else:
                        self.assertEqual(graph["failure"]["type"], "TimeoutError")
                        self.assertEqual(graph["resources"]["physicalRequests"], 0)
                native.downstream.assert_not_called()
                with self.assertRaisesRegex(ValueError, "already started"):
                    experiment.execute(root / "plan.json")
                self.assertEqual(calls, expected_calls)

    def test_failed_arm_is_retained_and_prevents_all_held_out_fitting_and_replay(self):
        self._assert_failed_arms_retained()

    def test_post_run_identity_outage_preserves_failure_and_usage_receipts(self):
        self._assert_failed_arms_retained("after")

    def test_pre_run_identity_outage_records_an_unstarted_arm_without_inference(self):
        self._assert_failed_arms_retained("before")

    def test_native_auxiliary_fallbacks_block_fitting_even_with_a_complete_factor_pool(
        self,
    ):
        self._assert_failed_arms_retained(auxiliary_failure=True)


class PhysicalAuditTests(unittest.TestCase):
    def test_missing_evaluations_and_resealed_ledgers_fail_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run = {"runId": "fixture", "seed": 123, "arm": "graph"}
            output = root / "receipts" / "fixture"
            (output / "wire").mkdir(parents=True)
            request = {
                "model": experiment.MODEL,
                "seed": 123,
                "max_tokens": 100,
                **experiment.PROFILE,
            }
            usage = {"prompt_tokens": 1, "completion_tokens": 3, "total_tokens": 4}
            content = json.dumps({"suggestions": ["Normalize close."]})
            response = {
                "model": experiment.MODEL,
                "usage": usage,
                "choices": [{"message": {"content": content}}],
            }
            experiment.write_json(output / "wire/000001-request.json", request)
            experiment.write_json(output / "wire/000001-response.json", response)
            factors = ["a", "b", "c", "d"]
            evaluations = root / "runs/fixture/objects/evaluation_result"
            evaluations.mkdir(parents=True)
            for factor in factors:
                experiment.write_json(
                    evaluations / (factor + ".json"),
                    {
                        "factor_id": factor,
                        "forward_return_ref": {"artifact_id": "returns"},
                    },
                )
            target = root / "pools/fixture/factor_library/factors.csv"
            target.parent.mkdir(parents=True)
            target.write_text("factor_id\n" + "\n".join(factors) + "\n")
            experiment.write_json(
                output / "pool.json",
                {
                    "factorIds": factors,
                    "evaluableFactors": 4,
                    "csvSha256": experiment.digest(target),
                },
            )
            events = [
                {"event": "proposal-reserved", "slots": 4},
                *[
                    {"event": "evaluable-factor", "factorId": factor}
                    for factor in factors
                ],
                {
                    "event": "started",
                    "number": 1,
                    "seed": 123,
                    "maxTokens": 100,
                    "model": experiment.MODEL,
                    "parameters": experiment.PROFILE,
                    "authorizationHeaderSent": False,
                    "requestSha256": experiment.digest(
                        output / "wire/000001-request.json"
                    ),
                },
                {
                    "event": "received",
                    "number": 1,
                    "usage": usage,
                    "servingIdentity": {},
                    "responseSha256": experiment.digest(
                        output / "wire/000001-response.json"
                    ),
                },
            ]
            received_event = events[-1]
            auxiliary_event = {
                "event": "auxiliary-response",
                "purpose": "suggestion",
                "valid": True,
                "contentSha256": experiment.hashlib.sha256(
                    content.encode()
                ).hexdigest(),
            }
            events.append(auxiliary_event)
            journal = output / "requests.jsonl"
            journal.write_text("".join(json.dumps(event) + "\n" for event in events))
            receipt = {
                "experimentId": "experiment",
                "targetId": "target",
                "status": "COMPLETE",
                "identityUnchanged": True,
                "resources": {
                    "physicalRequests": 1,
                    "completionTokens": 3,
                    "promptTokens": 1,
                    "rejectedRequests": 0,
                    "unknownUsageRequests": 0,
                    "evaluableFactors": 4,
                    "requestedProposalSlots": 4,
                    "successfulAuxiliaryResponses": 1,
                    "failedAuxiliaryResponses": 0,
                },
            }
            experiment.write_json(output / "result.json", receipt)
            model_root = root / "models/fixture-model"
            model_root.mkdir(parents=True)
            model = {"selected_factor_count": 4}
            for key in [
                "model_ref",
                "training_curve_ref",
                "predictions_ref",
                "daily_signal_metrics_ref",
                "portfolio_report_ref",
                "portfolio_positions_ref",
            ]:
                raw = key.encode()
                aid = experiment.hashlib.sha256(raw).hexdigest()
                artifact = model_root / "artifacts" / aid[:2] / aid
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(raw)
                model[key] = {"artifact_id": aid, "size_bytes": len(raw)}
            experiment.write_json(output / "model-result.json", model)
            consumption = {"targetId": "target"}
            experiment.write_json(model_root / "target-consumption.json", consumption)
            plan = {
                "experimentId": "experiment",
                "targetId": "target",
                "kind": "acceptance",
                "runs": [run],
                "modelIdentity": {},
                "limits": experiment.asdict(experiment.limits_for("acceptance")),
                "inputs": {
                    "mining": {"targetArtifactId": "returns"},
                    "downstream": consumption,
                },
            }
            with patch.object(experiment, "load_plan", return_value=(root, plan)):
                self.assertEqual(experiment.audit(root / "plan.json")["status"], "PASS")
                missing = evaluations / "a.json"
                original = missing.read_bytes()
                missing.unlink()
                self.assertEqual(experiment.audit(root / "plan.json")["status"], "FAIL")
                missing.write_bytes(original)
                response["choices"][0]["message"]["content"] = ""
                raw_response = output / "wire/000001-response.json"
                raw_response.write_text(json.dumps(response))
                received_event["responseSha256"] = experiment.digest(raw_response)
                auxiliary_event["contentSha256"] = experiment.hashlib.sha256(
                    b""
                ).hexdigest()
                journal.write_text(
                    "".join(json.dumps(event) + "\n" for event in events)
                )
                self.assertEqual(experiment.audit(root / "plan.json")["status"], "FAIL")
                response["choices"][0]["message"]["content"] = content
                raw_response.write_text(json.dumps(response))
                received_event["responseSha256"] = experiment.digest(raw_response)
                auxiliary_event["contentSha256"] = experiment.hashlib.sha256(
                    content.encode()
                ).hexdigest()
                received_event["usage"] = {
                    "prompt_tokens": 1,
                    "completion_tokens": 2,
                    "total_tokens": 3,
                }
                journal.write_text(
                    "".join(json.dumps(event) + "\n" for event in events)
                )
                receipt["resources"]["completionTokens"] = 2
                (output / "result.json").write_text(json.dumps(receipt))
                self.assertEqual(experiment.audit(root / "plan.json")["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()

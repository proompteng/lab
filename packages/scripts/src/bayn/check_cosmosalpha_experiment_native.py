"""Run native contracts against a prepared full-data input set, without inference."""

from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from cosmosalpha.agents import FactorProposal
from cosmosalpha.core import ObjectRef, create_config_snapshot
from cosmosalpha.core.config import load_experiment_config
from cosmosalpha.evaluation import (
    ForwardReturnCalculator,
    GplearnNeutralizedPreprocessor,
)
from cosmosalpha.evaluation.evaluator import FactorEvaluator
from cosmosalpha.factors import (
    FactorCalculator,
    build_base_field_catalog,
    build_base_operator_catalog,
    validate_factor_proposal,
)
from cosmosalpha.pipeline.runtime import RuntimeBuilder, RuntimeDependencies
from cosmosalpha.pipeline.runtime import _base_context
from cosmosalpha.pipeline.mcts.controller import MCTSController, MCTSResult
from cosmosalpha.pipeline.mcts.core import MCTSNode, MCTSTree
from cosmosalpha.storage import LocalArtifactRepository, LocalExperimentRepository

from cosmosalpha_experiment import (
    ArmBudget,
    CheckedModelClient,
    EvaluableTargetReached,
    Limits,
)
from cosmosalpha_native_experiment import (
    FrozenInputs,
    admit_model_config,
    bind_loop,
    validate_model_source,
)


ROOT = Path(sys.argv.pop(1)).resolve().parent
PLAN = json.loads((ROOT / "plan.json").read_text())


class NativeContracts(unittest.TestCase):
    def test_target_stop_escapes_native_suggestion_fallback_without_a_model_call(self):
        budget = ArmBudget(Limits(evaluable_factors=1))
        budget.evaluable["completed"] = object()
        delegate = unittest.mock.Mock()
        controller = MCTSController(
            None,
            None,
            None,
            llm_client=CheckedModelClient(delegate, budget),
            field_catalog=build_base_field_catalog(),
            operator_catalog=build_base_operator_catalog(),
        )
        with self.assertRaises(EvaluableTargetReached):
            controller._step_a_suggest(
                MCTSNode(factor_id="completed", expression="close")
            )
        delegate.complete.assert_not_called()
        self.assertEqual(budget.summary()["failedAuxiliaryResponses"], 0)

    def test_native_multi_tree_rotates_free_roots_and_never_supplies_a_fixed_seed(self):
        run = next(run for run in PLAN["runs"] if run["arm"] == "mcts")
        frozen = FrozenInputs(ROOT, PLAN["inputs"]["mining"])
        with tempfile.TemporaryDirectory() as temp:
            source = load_experiment_config(ROOT / run["config"])
            config = replace(source, storage=replace(source.storage, root=temp))
            runtime = RuntimeBuilder(config, run_id="multi-tree-contract").build(
                resume=False
            )
            controller = MCTSController(
                runtime._loop,
                runtime._objects,
                runtime._artifacts,
                field_catalog=build_base_field_catalog(),
                operator_catalog=build_base_operator_catalog(),
            )
            roots = []

            class Generator:
                def generate(self, **kwargs):
                    roots.append(kwargs["run_id"])
                    return MCTSNode(factor_id=str(len(roots)), expression="close")

            def one_tree(**kwargs):
                self.assertNotIn("seed_expression", kwargs)
                return MCTSResult(
                    tree=MCTSTree(root=kwargs["root"]), iterations=1, best_rank_ic=0.0
                )

            with patch.object(controller, "run", side_effect=one_tree):
                result = controller.run_multi_tree(
                    data_snapshot=frozen.snapshot,
                    base_context=_base_context(config, frozen.snapshot),
                    config_snapshot_ref=runtime._config_snapshot_ref,
                    code_version="native-contract",
                    run_id="multi-tree-contract",
                    max_total_rounds=3,
                    root_generator=Generator(),
                )
            self.assertEqual(result.iterations, 3)
            self.assertEqual(
                roots,
                [
                    "multi-tree-contract-tree001",
                    "multi-tree-contract-tree002",
                    "multi-tree-contract-tree003",
                ],
            )

    def test_all_three_native_loop_contracts_accept_the_frozen_calculator(self):
        frozen = FrozenInputs(ROOT, PLAN["inputs"]["mining"])
        for run in PLAN["runs"]:
            with self.subTest(arm=run["arm"]), tempfile.TemporaryDirectory() as temp:
                original = load_experiment_config(ROOT / run["config"])
                config = replace(original, storage=replace(original.storage, root=temp))
                runtime = RuntimeBuilder(
                    config,
                    run_id=run["runId"],
                    dependencies=RuntimeDependencies(
                        market_data_provider_factory=frozen.provider
                    ),
                ).build(resume=False)
                loop = (
                    runtime._loop
                    if run["arm"] == "mcts"
                    else runtime._graph_loop_factory()
                )
                bind_loop(loop, frozen, ArmBudget(Limits()), 2)
                loop.set_reference_factor_values_provider(runtime._factor_library)
                self.assertIs(loop._forward_return_calculator, frozen)

    def test_mcts_source_is_accepted_without_changing_its_architecture_label(self):
        for run in PLAN["runs"]:
            source = load_experiment_config(ROOT / run["config"])
            model = admit_model_config(ROOT / run["downstreamConfig"])
            validate_model_source(model, create_config_snapshot(source))
            self.assertEqual(
                source.architecture.name, "mcts" if run["arm"] == "mcts" else "graph"
            )
            contaminated = replace(
                source, data=replace(source.data, end_date="2020-12-31")
            )
            with self.assertRaisesRegex(ValueError, "training segment"):
                validate_model_source(model, create_config_snapshot(contaminated))

    def test_real_factor_calculation_preprocessing_and_evaluation_use_verified_labels(
        self,
    ):
        frozen = FrozenInputs(ROOT, PLAN["inputs"]["mining"])
        with tempfile.TemporaryDirectory() as temp:
            artifacts = LocalArtifactRepository(temp)
            objects = LocalExperimentRepository(temp)
            snapshot = frozen.copy(artifacts)
            proposal = FactorProposal(
                proposal_id="contract-close",
                factor_design_ref=ObjectRef(
                    "factor_design", "contract", "factor-design/1.0"
                ),
                hypothesis_id="contract",
                name="Close contract fixture",
                proposed_expression="close",
                description="Exercise native data and target consumers",
                frequency="1d",
                expected_direction="positive",
                generation_attempt=1,
                schema_version="factor-proposal/2.0",
            )
            validation = validate_factor_proposal(
                proposal, build_base_field_catalog(), build_base_operator_catalog()
            )
            self.assertIsNotNone(validation.factor_spec)
            report_ref = objects.put_object(
                "validation_report", "contract", validation.report
            )
            with patch.object(
                ForwardReturnCalculator,
                "calculate",
                side_effect=AssertionError("Legacy targets must not run"),
            ):
                calculated = FactorCalculator(artifacts).calculate(
                    validation.factor_spec, snapshot, validation_report_ref=report_ref
                )
                preprocessed = GplearnNeutralizedPreprocessor(
                    artifacts, min_cross_section_samples=100
                ).preprocess(calculated, frozen.calculate(snapshot), snapshot)
                preprocessed_ref = objects.put_object(
                    "factor_preprocessing_result", "contract", preprocessed
                )
                evaluated = FactorEvaluator(
                    artifacts, min_cross_section_samples=100
                ).evaluate(preprocessed, preprocessed_ref, snapshot)
            self.assertEqual(
                evaluated.forward_return_ref.artifact_id,
                PLAN["inputs"]["mining"]["targetArtifactId"],
            )
            self.assertEqual(
                evaluated.data_snapshot_id, PLAN["inputs"]["mining"]["snapshotId"]
            )
            self.assertGreater(evaluated.effective_sample_count, 100)


if __name__ == "__main__":
    unittest.main()

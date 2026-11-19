"""Native MCTS candidate-evidence regressions; no model or network calls."""

import json
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import Mock

import numpy as np
from cosmosalpha.agents import (
    EvaluationResult,
    ExperimentRecord,
    ExperimentStatus,
    FactorPreprocessingResult,
    FactorSpec,
    MetricValue,
    ResearchContext,
    ValidationReport,
)
from cosmosalpha.core import ObjectRef, records_to_aligned_values
from cosmosalpha.factors import build_base_field_catalog, build_base_operator_catalog
from cosmosalpha.pipeline.loop import CandidateRunResult, CosmosAlphaLoopResult
from cosmosalpha.pipeline.mcts.controller import MCTSController
from cosmosalpha.pipeline.mcts.core import MCTSNode
from cosmosalpha.storage import LocalArtifactRepository, LocalExperimentRepository


class CandidateBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.objects = LocalExperimentRepository(self.temp.name)
        self.artifacts = LocalArtifactRepository(self.temp.name)
        self.dates = tuple(f"2020-01-{day:02d}" for day in range(1, 7))
        self.config = self.artifacts.put_bytes(
            b"{}", kind="config_snapshot", media_type="application/json"
        )
        self.context = ResearchContext(
            research_goal="Bind each MCTS node to one measured candidate",
            market="fixture",
            universe="fixture",
            frequency="1d",
            available_fields=("close", "volume"),
            operator_catalog_ref=ObjectRef("catalog", "operators", "catalog/1.0"),
            evaluation_protocol_ref=ObjectRef("protocol", "evaluation", "protocol/1.0"),
            history_summaries=(),
            constraints=(),
            research_direction=None,
            research_direction_ref=None,
            schema_version="research-context/1.0",
        )
        self.candidates = []
        self.specs = []
        self.preprocessings = []
        self.evaluations = []
        self.evaluated_records = []
        for index, expression in enumerate(("close", "volume")):
            factor_id = f"factor-identity-{index}"
            proposal_id = f"proposal-{index}"
            raw = self.records(
                (10.0, 20.0, 30.0, 40.0),
                reverse_last=index == 0,
            )
            evaluated = self.records(
                (1.0, -1.0, -1.0, 1.0) if index == 0 else (1.0, 2.0, 3.0, 4.0)
            )
            raw_ref = self.put_records(raw, "factor_values")
            evaluated_ref = self.put_records(evaluated, "evaluated_factor_values")
            returns_ref = self.put_records(
                self.records((0.01, 0.02, 0.03, 0.04)), "returns"
            )
            spec = FactorSpec(
                factor_id=factor_id,
                proposal_id=proposal_id,
                hypothesis_id="hypothesis",
                name=expression,
                expression=expression,
                description="Candidate binding fixture",
                frequency="1d",
                required_fields=(expression,),
                expected_direction="positive",
                operator_set_version="operator-set-base/1.0",
                field_schema_version="field-catalog/1.0",
                expression_schema_version="factor-expression/1.0",
                schema_version="factor-spec/1.0",
            )
            factor_ref = self.objects.put_object("factor_spec", f"spec-{index}", spec)
            validation = ValidationReport(
                proposal_id=proposal_id,
                factor_id=factor_id,
                is_valid=True,
                normalized_expression=expression,
                required_fields=(expression,),
                required_lookback=0,
                issues=(),
                validator_version="fixture",
                schema_version="validation-report/1.0",
            )
            validation_ref = self.objects.put_object(
                "validation_report", f"validation-{index}", validation
            )
            pre = FactorPreprocessingResult(
                factor_id=factor_id,
                data_snapshot_id="snapshot",
                input_factor_values_ref=raw_ref,
                eligible_factor_values_ref=evaluated_ref,
                winsorized_factor_values_ref=evaluated_ref,
                neutralized_factor_values_ref=evaluated_ref,
                evaluated_factor_values_ref=evaluated_ref,
                forward_return_ref=returns_ref,
                exposure_data_ref=returns_ref,
                mask_data_ref=returns_ref,
                preprocessing_protocol_id="preprocessing",
                preprocessing_protocol_version="1.0",
                neutralization_applied=True,
                excluded_sample_count=0,
                effective_sample_count=24,
                warnings=(),
                schema_version="factor-preprocessing-result/1.0",
            )
            pre_ref = self.objects.put_object(
                "factor_preprocessing_result", f"preprocessing-{index}", pre
            )
            evaluation = EvaluationResult(
                factor_id=factor_id,
                data_snapshot_id="snapshot",
                raw_factor_values_ref=raw_ref,
                evaluated_factor_values_ref=evaluated_ref,
                factor_preprocessing_result_ref=pre_ref,
                forward_return_ref=returns_ref,
                evaluation_protocol_id="evaluation",
                preprocessing_protocol_id="preprocessing",
                neutralization_applied=True,
                metrics=(
                    self.metric("rank_ic_mean", (0.01, 0.03)[index]),
                    self.metric("rank_ic_ir", (0.1, 0.9)[index]),
                ),
                effective_date_count=6,
                effective_sample_count=24,
                coverage=1.0,
                warnings=(),
                evaluator_version="fixture",
                schema_version="evaluation-result/1.1",
                total_date_count=6,
            )
            evaluation_ref = self.objects.put_object(
                "evaluation_result", f"evaluation-{index}", evaluation
            )
            self.candidates.append(
                CandidateRunResult(
                    proposal_ref=ObjectRef(
                        "factor_proposal", proposal_id, "factor-proposal/2.0"
                    ),
                    validation_report_ref=validation_ref,
                    status=(ExperimentStatus.REJECTED, ExperimentStatus.ACCEPTED)[
                        index
                    ],
                    factor_ref=factor_ref,
                    preprocessing_result_ref=pre_ref,
                    evaluation_result_ref=evaluation_ref,
                )
            )
            self.specs.append(spec)
            self.preprocessings.append(pre)
            self.evaluations.append(evaluation)
            self.evaluated_records.append(evaluated)
        now = datetime.now(UTC)
        self.record = ExperimentRecord(
            experiment_id="experiment",
            run_id="run",
            cycle_id="cycle",
            status=ExperimentStatus.ACCEPTED,
            parent_ids=(),
            hypothesis_ref=ObjectRef(
                "research_hypothesis", "hypothesis", "research-hypothesis/1.0"
            ),
            factor_proposal_refs=tuple(c.proposal_ref for c in self.candidates),
            factor_refs=tuple(c.factor_ref for c in self.candidates),
            validation_report_refs=tuple(
                c.validation_report_ref for c in self.candidates
            ),
            calculation_result_refs=(),
            factor_preprocessing_result_refs=tuple(
                c.preprocessing_result_ref for c in self.candidates
            ),
            evaluation_result_refs=tuple(
                c.evaluation_result_ref for c in self.candidates
            ),
            acceptance_decision_refs=(),
            feedback_ref=None,
            config_snapshot_ref=self.config,
            code_version="fixture",
            data_version="snapshot",
            created_at=now,
            completed_at=now,
            schema_version="experiment-record/1.0",
        )
        self.loop = Mock()
        self.controller = MCTSController(
            self.loop,
            self.objects,
            self.artifacts,
            field_catalog=build_base_field_catalog(),
            operator_catalog=build_base_operator_catalog(),
            correlation_min_cross_section_samples=4,
        )
        self.controller._correlation_dates = self.dates
        self.controller._correlation_eligible_counts = {d: 4 for d in self.dates}
        peer = MCTSNode(factor_id="peer", expression="peer", rank_ic_mean=0.02)
        peer.factor_values, peer.factor_keys = records_to_aligned_values(
            self.evaluated_records[1], preserve_missing=True
        )
        self.controller._shared_zoo = {"peer": peer}
        self.refresh_result()

    @staticmethod
    def metric(name, value):
        return MetricValue(name, value, "higher_is_better", 24, "fixture")

    def records(self, values, reverse_last=False):
        return tuple(
            {"datetime": day, "instrument": f"asset-{index}", "factor_value": value}
            for day_index, day in enumerate(self.dates)
            for index, value in enumerate(
                tuple(reversed(values)) if reverse_last and day_index == 5 else values
            )
        )

    def put_records(self, records, kind):
        return self.artifacts.put_bytes(
            json.dumps({"records": records}).encode(),
            kind=kind,
            media_type="application/json",
        )

    def refresh_result(self):
        self.loop.run.return_value = CosmosAlphaLoopResult(
            run_id="run",
            cycle_id="cycle",
            experiment_ref=ObjectRef(
                "experiment_record", "experiment", "experiment-record/1.0"
            ),
            experiment_record=self.record,
            hypothesis_ref=self.record.hypothesis_ref,
            factor_design_batch_ref=None,
            feedback_ref=None,
            candidate_results=tuple(self.candidates),
            recovery_issues=(),
            resumed=False,
        )

    def replace_evaluation(self, index, **changes):
        value = replace(self.evaluations[index], **changes)
        ref = self.objects.put_object(
            "evaluation_result", f"changed-evaluation-{index}", value
        )
        self.candidates[index] = replace(
            self.candidates[index], evaluation_result_ref=ref
        )
        refs = list(self.record.evaluation_result_refs)
        refs[index] = ref
        self.record = replace(self.record, evaluation_result_refs=tuple(refs))
        self.refresh_result()

    def build(self, expansion=False):
        self.refresh_result()
        kwargs = {
            "data_snapshot": None,
            "base_context": self.context,
            "config_snapshot_ref": self.config,
            "code_version": "fixture",
            "run_id": "fixture",
        }
        if expansion:
            return self.controller._expand(
                parent=MCTSNode(factor_id="parent", expression="open"),
                iteration=1,
                **kwargs,
            )
        return self.controller._build_root(seed_expression=None, **kwargs)

    def assert_rejected(self):
        with self.assertRaises(ValueError):
            self.build()
        self.assertIsNone(self.build(expansion=True))

    def assert_selected_second(self, node):
        self.assertIsNotNone(node)
        self.assertEqual(node.expression, "volume")
        self.assertEqual(node.rank_ic_mean, 0.03)
        self.assertEqual(node.stability, 0.9)
        self.assertAlmostEqual(node.turnover, 1.0)
        self.assertAlmostEqual(node.diversity, 0.0)
        expected_values, expected_keys = records_to_aligned_values(
            self.evaluated_records[1], preserve_missing=True
        )
        np.testing.assert_array_equal(node.factor_values, expected_values)
        self.assertEqual(node.factor_keys, expected_keys)

    def test_root_binds_second_accepted_design_to_its_own_metrics_and_values(self):
        self.assert_selected_second(self.build())

    def test_expansion_binds_second_accepted_design_to_its_own_metrics_and_values(self):
        self.assert_selected_second(self.build(expansion=True))

    def test_first_accepted_design_is_preserved_without_maximizing_another_metric(self):
        self.candidates[0] = replace(
            self.candidates[0], status=ExperimentStatus.ACCEPTED
        )
        node = self.build()
        self.assertEqual(node.expression, "close")
        self.assertEqual(node.rank_ic_mean, 0.01)
        self.assertAlmostEqual(node.turnover, -1.0)
        self.assertAlmostEqual(node.diversity, 1.0)

    def test_measured_zero_remains_a_valid_root(self):
        self.candidates[1] = replace(
            self.candidates[1], status=ExperimentStatus.REJECTED
        )
        self.replace_evaluation(0, metrics=(self.metric("rank_ic_mean", 0.0),))
        node = self.build()
        self.assertEqual(node.expression, "close")
        self.assertEqual(node.rank_ic_mean, 0.0)

    def test_missing_metric_remains_distinct_from_zero(self):
        self.replace_evaluation(1, metrics=(self.metric("rank_ic_ir", 0.9),))
        with self.assertRaises(ValueError):
            self.build()
        node = self.build(expansion=True)
        self.assertIsNone(node.rank_ic_mean)
        self.assertEqual(node.expression, "volume")
        self.assertEqual(self.controller._evaluated_factor_count, 1)

    def test_missing_selected_factor_reference_is_rejected(self):
        self.candidates[1] = replace(self.candidates[1], factor_ref=None)
        self.assert_rejected()

    def test_missing_selected_evaluation_reference_is_rejected(self):
        self.candidates[1] = replace(self.candidates[1], evaluation_result_ref=None)
        self.assert_rejected()

    def test_missing_selected_preprocessing_reference_is_rejected(self):
        self.candidates[1] = replace(self.candidates[1], preprocessing_result_ref=None)
        self.assert_rejected()

    def test_duplicate_selected_candidate_is_rejected(self):
        self.candidates.append(self.candidates[1])
        self.assert_rejected()

    def test_duplicate_selected_record_reference_is_rejected(self):
        self.record = replace(
            self.record,
            evaluation_result_refs=self.record.evaluation_result_refs
            + (self.candidates[1].evaluation_result_ref,),
        )
        self.assert_rejected()

    def test_unindexed_selected_reference_is_rejected(self):
        self.record = replace(
            self.record,
            factor_preprocessing_result_refs=self.record.factor_preprocessing_result_refs[
                :1
            ],
        )
        self.assert_rejected()

    def test_cross_factor_evaluation_identity_is_rejected(self):
        self.replace_evaluation(1, factor_id=self.specs[0].factor_id)
        self.assert_rejected()

    def test_cross_candidate_preprocessing_reference_is_rejected(self):
        self.replace_evaluation(
            1,
            factor_preprocessing_result_ref=self.candidates[0].preprocessing_result_ref,
        )
        self.assert_rejected()

    def test_cross_candidate_raw_values_are_rejected(self):
        self.replace_evaluation(
            1, raw_factor_values_ref=self.preprocessings[0].input_factor_values_ref
        )
        self.assert_rejected()

    def test_cross_candidate_evaluated_values_are_rejected(self):
        self.replace_evaluation(
            1,
            evaluated_factor_values_ref=self.preprocessings[
                0
            ].evaluated_factor_values_ref,
        )
        self.assert_rejected()

    def test_cross_snapshot_evaluation_is_rejected(self):
        self.replace_evaluation(1, data_snapshot_id="another-snapshot")
        self.assert_rejected()

    def test_duplicate_metric_identity_is_rejected(self):
        self.replace_evaluation(
            1,
            metrics=self.evaluations[1].metrics + (self.metric("rank_ic_mean", 0.99),),
        )
        self.assert_rejected()


if __name__ == "__main__":
    unittest.main()

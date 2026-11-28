"""Audit retained single-candidate MCTS evidence without running inference.

Usage: repaired-python audit_native_binding.py ACCEPTANCE_ROOT NEW_REPORT_JSON
This audit does not reconstruct missing native tree state or rerun evaluation.
"""

import csv
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from cosmosalpha.agents import AcceptanceDecision, ExperimentRecord, ExperimentStatus
from cosmosalpha.core import ObjectRef, from_json, stable_sha256
from cosmosalpha.core.columnar import decode_record_artifact_table
from cosmosalpha.pipeline.loop import CandidateRunResult, CosmosAlphaLoopResult
from cosmosalpha.pipeline.mcts import controller
from cosmosalpha.pipeline.mcts.core import MCTSTreeSnapshot
from cosmosalpha.storage import LocalArtifactRepository, LocalExperimentRepository

CONTROLLER_SHA256 = "0f8f9a3f8d370fc867c585ee740f703b93596de89044026318f14a76c27498c6"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path):
    with path.open(newline="") as stream:
        return list(csv.DictReader(stream))


def audit(root):
    plan = json.loads((root / "plan.json").read_text())
    source = root / plan["sourceIdentityFile"]
    require(sha256(source) == plan["sourceIdentitySha256"], "Source manifest drift")
    require(sha256(Path(controller.__file__)) == CONTROLLER_SHA256, "Wrong selector")
    (run,) = [run for run in plan["runs"] if run["arm"] == "mcts"]
    native = root / "runs" / run["runId"]
    receipt = root / "receipts" / run["runId"]
    require(
        json.loads((receipt / "result.json").read_text())["status"] == "COMPLETE",
        "MCTS arm is not complete",
    )
    objects = LocalExperimentRepository(native)
    artifacts = LocalArtifactRepository(native)
    pool = rows(root / "pools" / run["runId"] / "factor_library/factors.csv")
    require(
        len(pool) == len({row["factor_id"] for row in pool}), "Duplicate pool factor"
    )
    records, selected = [], {}
    paths = sorted((native / "objects/experiment_record").glob("*.json"))
    require(
        len(paths) == plan["limits"]["evaluable_factors"], "Unexpected record count"
    )
    for path in paths:
        record = from_json(path.read_bytes(), ExperimentRecord)
        fields = (
            "factor_proposal_refs",
            "validation_report_refs",
            "factor_refs",
            "calculation_result_refs",
            "factor_preprocessing_result_refs",
            "evaluation_result_refs",
            "acceptance_decision_refs",
        )
        require(
            all(len(getattr(record, name)) == 1 for name in fields),
            "Audit requires unambiguous single-candidate stage references",
        )
        decision = objects.get_object(
            record.acceptance_decision_refs[0], AcceptanceDecision
        )
        status = (
            ExperimentStatus.ACCEPTED
            if decision.accepted
            else ExperimentStatus.REJECTED
        )
        candidate = CandidateRunResult(
            proposal_ref=record.factor_proposal_refs[0],
            validation_report_ref=record.validation_report_refs[0],
            factor_ref=record.factor_refs[0],
            calculation_result_ref=record.calculation_result_refs[0],
            preprocessing_result_ref=record.factor_preprocessing_result_refs[0],
            evaluation_result_ref=record.evaluation_result_refs[0],
            acceptance_decision_ref=record.acceptance_decision_refs[0],
            status=status,
        )
        result = CosmosAlphaLoopResult(
            run_id=record.run_id,
            cycle_id=record.cycle_id,
            experiment_ref=ObjectRef(
                "experiment_record", record.experiment_id, record.schema_version
            ),
            experiment_record=record,
            hypothesis_ref=record.hypothesis_ref,
            factor_design_batch_ref=None,
            feedback_ref=record.feedback_ref,
            candidate_results=(candidate,),
            recovery_issues=(),
            resumed=False,
        )
        evidence = controller._select_candidate_evidence(
            result, objects, frequency="1d"
        )
        factor, evaluation, pre = (
            evidence.factor,
            evidence.evaluation,
            evidence.preprocessing,
        )
        scores = controller._extract_eval_scores(evidence)
        require(
            decision.factor_id == factor.factor_id
            and decision.evaluation_result_ref == candidate.evaluation_result_ref,
            "Acceptance decision is not bound to the selected candidate",
        )
        require(
            pre.forward_return_ref.artifact_id
            == plan["inputs"]["mining"]["targetArtifactId"],
            "Selected candidate has a different target",
        )
        cycle = native / "cycles" / record.cycle_id
        manifest = json.loads((cycle / "result.json").read_text())
        require(
            from_json(json.dumps(manifest["experiment_record"]), ExperimentRecord)
            == record,
            "Cycle manifest differs from its native record",
        )
        cycle_rows = rows(cycle / "factors.csv")
        pool_rows = [row for row in pool if row["factor_id"] == factor.factor_id]
        require(len(cycle_rows) == len(pool_rows) == 1, "Ambiguous CSV membership")
        for row in (cycle_rows[0], pool_rows[0]):
            require(
                row["expression"] == factor.expression
                and row["factor_id"] == factor.factor_id
                and row["experiment_id"] == record.experiment_id
                and row["status"] == status.value
                and row["data_snapshot_id"] == pre.data_snapshot_id
                and row["evaluation_protocol_id"] == evaluation.evaluation_protocol_id
                and float(row["rank_ic_mean"]) == scores["rank_ic"]
                and float(row["rank_ic_ir"]) == scores["stability"]
                and row["raw_factor_values_artifact_id"]
                == pre.input_factor_values_ref.artifact_id
                and row["evaluated_factor_values_artifact_id"]
                == pre.evaluated_factor_values_ref.artifact_id,
                "CSV expression, score or artifact belongs to another candidate",
            )
        checks, keys = [], None
        for role, ref, value_name in (
            ("raw", pre.input_factor_values_ref, "factor_value"),
            ("evaluated", pre.evaluated_factor_values_ref, "factor_value"),
            ("target", pre.forward_return_ref, "forward_return"),
        ):
            data = artifacts.get_bytes(ref)
            digest = hashlib.sha256(data).hexdigest()
            require(
                digest == ref.artifact_id
                and ref.checksum == "sha256:" + digest
                and len(data) == ref.size_bytes,
                "Artifact bytes differ from their reference",
            )
            table = decode_record_artifact_table(data)
            current_keys = tuple(
                table.columns[name] for name in ("datetime", "instrument")
            )
            require(
                all(
                    np.all(table.validity[name]) for name in ("datetime", "instrument")
                ),
                "Artifact contains missing alignment keys",
            )
            require(
                table.row_count == plan["inputs"]["mining"]["rowsMatched"],
                "Artifact row count differs from frozen mining input",
            )
            if keys is not None:
                require(
                    all(
                        np.array_equal(a, b)
                        for a, b in zip(keys, current_keys, strict=True)
                    ),
                    "Raw, evaluated and target artifact keys differ",
                )
            keys = current_keys
            finite = table.validity[value_name] & np.isfinite(table.columns[value_name])
            checks.append(
                {
                    "role": role,
                    "sha256": digest,
                    "sizeBytes": len(data),
                    "rows": table.row_count,
                    "finiteValues": int(finite.sum()),
                }
            )
        selected[record.experiment_id] = evidence
        records.append(
            {
                "experimentId": record.experiment_id,
                "recordSha256": sha256(path),
                "cycleId": record.cycle_id,
                "candidateCount": 1,
                "factorId": factor.factor_id,
                "expression": factor.expression,
                "rankIC": scores["rank_ic"],
                "stability": scores["stability"],
                "status": status.value,
                "cycleCsvSha256": sha256(cycle / "factors.csv"),
                "artifactChecks": checks,
            }
        )
    design_batches = [
        {
            "sha256": sha256(path),
            "designCount": len(json.loads(path.read_text())["designs"]),
        }
        for path in sorted((native / "objects/factor_design_batch").glob("*.json"))
    ]
    require(len(design_batches) == len(records), "Unmatched design batches")
    require(
        all(batch["designCount"] == 1 for batch in design_batches),
        "A multi-design live result requires a separate candidate mapping audit",
    )
    trees, node_checks = sorted((native / "objects/mcts_tree").glob("*.json")), []
    for path in trees:
        tree = from_json(path.read_bytes(), MCTSTreeSnapshot)
        for node in tree.nodes:
            require(
                node.experiment_ref is not None, "Saved node lacks experiment identity"
            )
            evidence = selected[node.experiment_ref["object_id"]]
            scores = controller._extract_eval_scores(evidence)
            require(
                node.expression == evidence.factor.expression
                and node.rank_ic_mean == scores["rank_ic"]
                and node.stability == scores["stability"]
                and node.factor_id
                == stable_sha256(
                    {
                        "expression": evidence.factor.expression,
                        "frequency": evidence.factor.frequency,
                    }
                ),
                "Saved node expression or metrics differ from selected candidate",
            )
            node_checks.append({"treeSha256": sha256(path), "factorId": node.factor_id})
    native_result = json.loads((receipt / "native-result.json").read_text())
    require(native_result["trees"] == len(trees), "Native tree count differs")
    return {
        "schemaVersion": "bayn.cosmosalpha-retained-candidate-binding-audit.v1",
        "experimentId": plan["experimentId"],
        "planSha256": sha256(root / "plan.json"),
        "sourceIdentitySha256": sha256(source),
        "controllerSha256": CONTROLLER_SHA256,
        "result": "PASS_RETAINED_CANDIDATE_EVIDENCE",
        "inferenceCalls": 0,
        "method": "Replay the exact native selector for unambiguous retained candidates; compare native records, acceptance decisions, cycle/pool CSVs and raw/evaluated/target artifact identities and alignment. No evaluation rerun or missing-node reconstruction.",
        "records": records,
        "designBatches": design_batches,
        "liveTwoDesignResults": 0,
        "nativeTreeVerification": {
            "status": "PASS_SAVED_SCALARS" if trees else "NOT_AVAILABLE",
            "treeSnapshots": len(trees),
            "nodesCompared": len(node_checks),
            "checks": node_checks,
            "terminationReason": native_result.get("terminationReason"),
            "factorArraysPersistedInNativeNodes": False,
            "limitation": "Quota-stop can precede native tree persistence. Native node arrays are memory-only; selected artifact bytes are verified separately. Two-design node binding is proved by the exact-source regression, not by these single-design live results.",
        },
    }


if __name__ == "__main__":
    root, output = map(Path, sys.argv[1:])
    require(not output.exists(), "Refusing to overwrite a prior audit")
    report = audit(root.resolve())
    report["auditScriptSha256"] = sha256(Path(__file__))
    with output.open("x") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(
        json.dumps(
            {
                "result": report["result"],
                "records": len(report["records"]),
                "nativeTrees": report["nativeTreeVerification"]["treeSnapshots"],
                "reportSha256": sha256(output),
            }
        )
    )

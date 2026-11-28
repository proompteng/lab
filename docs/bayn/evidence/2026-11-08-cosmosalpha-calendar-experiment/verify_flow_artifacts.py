"""Independently verify saved Flow propagation, conditional on recorded utilities."""

import argparse
import hashlib
import json
import tomllib
from pathlib import Path

import numpy as np


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(root):
    plan = read(root / "plan.json")
    checks = []
    for run in plan["runs"]:
        if run["arm"] == "mcts":
            continue
        config = tomllib.loads((root / run["config"]).read_text())["graph"]["flow"]
        objects = root / "runs" / run["runId"] / "objects"
        snapshots = {
            read(path)["next_round_index"]: path
            for path in (objects / "graph_snapshot").glob("*.json")
        }
        for path in sorted((objects / "graph_selector_audit").glob("*.json")):
            audit = read(path)
            snapshot_path = snapshots[audit["round_id"]]
            graph = read(snapshot_path)["graph"]
            ids = sorted(graph["node_index"], key=graph["node_index"].get)
            assert ids == audit["flow_node_ids"]
            transition = np.zeros((len(ids), len(ids)))
            for modality in ("structure", "correlation", "generation"):
                weights = np.array(graph["w_" + modality], dtype=float)
                assert np.all(np.isfinite(weights)) and np.all(weights >= 0)
                totals = weights.sum(axis=1)
                normalized = np.divide(
                    weights,
                    totals[:, None],
                    out=np.zeros_like(weights),
                    where=totals[:, None] != 0,
                )
                for i in np.flatnonzero(totals == 0):
                    normalized[i, i] = 1
                transition += config["modality_weights"][modality] * normalized
            assert np.max(np.abs(transition.sum(axis=1) - 1)) <= 1e-12
            rewards = np.array(audit["raw_rewards"], dtype=float)
            saved = np.array(audit["propagated_rewards"], dtype=float)
            gamma = config["gamma"]
            current = rewards.copy()
            for iteration in range(1, config["iterations"] + 1):
                updated = (1 - gamma) * rewards + gamma * transition @ current
                delta = float(np.max(np.abs(updated - current)))
                current = updated
                if delta <= config["convergence_tolerance"]:
                    break
            replay_error = float(np.max(np.abs(current - saved)))
            solution = np.linalg.solve(
                np.eye(len(ids)) - gamma * transition, (1 - gamma) * rewards
            )
            fixed_point_error = float(np.max(np.abs(solution - saved)))
            residual = float(
                np.max(
                    np.abs(saved - ((1 - gamma) * rewards + gamma * transition @ saved))
                )
            )
            bound = config["convergence_tolerance"] / (1 - gamma)
            assert replay_error <= 1e-12
            assert iteration == audit["flow_iterations"]
            assert delta <= config["convergence_tolerance"] and audit["flow_converged"]
            assert fixed_point_error <= bound + 1e-12
            assert residual <= config["convergence_tolerance"] + 1e-12
            checks.append(
                {
                    "runId": run["runId"],
                    "round": audit["round_id"],
                    "nodes": len(ids),
                    "gamma": gamma,
                    "iterations": iteration,
                    "auditSha256": sha(path),
                    "snapshotSha256": sha(snapshot_path),
                    "replayMaxAbsoluteError": replay_error,
                    "fixedPointMaxAbsoluteError": fixed_point_error,
                    "fixedPointErrorBound": bound,
                    "fixedPointResidual": residual,
                }
            )
    assert checks
    return {
        "schemaVersion": "bayn.cosmosalpha-independent-flow-check.v1",
        "experimentId": plan["experimentId"],
        "status": "PASS",
        "verifierSha256": sha(Path(__file__)),
        "statesVerified": len(checks),
        "checks": checks,
        "scope": "Independent relation normalization, NumPy recurrence and linear-system solution against saved native states. Conditional on recorded raw utilities and relation weights; does not rederive quality, fertility, graph construction or Pareto selection.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.experiment), indent=2))


if __name__ == "__main__":
    main()

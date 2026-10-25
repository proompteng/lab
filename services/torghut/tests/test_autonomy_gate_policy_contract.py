from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from yaml import safe_load

from app.trading.autonomy.policy_contract import (
    assert_runtime_gate_policy_contract,
    load_runtime_gate_policy,
    required_key_errors,
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _service_root() -> Path:
    return _repo_root() / "services" / "torghut"


def _load_gitops_runtime_policy_payload() -> dict[str, object]:
    config_map = (
        _repo_root()
        / "argocd"
        / "applications"
        / "torghut"
        / "autonomy-gate-policy-configmap.yaml"
    )
    manifest = safe_load(config_map.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise AssertionError("autonomy-gate-policy-configmap.yaml is not a YAML object")
    data = manifest.get("data")
    if not isinstance(data, dict):
        raise AssertionError("autonomy-gate-policy-configmap.yaml is missing data")
    raw_policy = data.get("autonomy-gates-v3.json")
    if not isinstance(raw_policy, str) or not raw_policy.strip():
        raise AssertionError(
            "autonomy-gate-policy-configmap.yaml is missing autonomy-gates-v3.json payload"
        )
    payload = json.loads(raw_policy)
    if not isinstance(payload, dict):
        raise AssertionError("autonomy-gates-v3.json payload is not a JSON object")
    return payload


class TestAutonomyGatePolicyContract(TestCase):
    def test_service_policy_alias_matches_autonomy_gates_v3(self) -> None:
        service_root = _service_root()
        canonical = load_runtime_gate_policy(
            service_root / "config" / "autonomy-gates-v3.json"
        )
        alias_payload = load_runtime_gate_policy(
            service_root / "config" / "autonomous-gate-policy.json"
        )
        self.assertEqual(alias_payload, canonical)

    def test_gitops_policy_payload_matches_service_canonical_policy(self) -> None:
        service_root = _service_root()
        canonical = load_runtime_gate_policy(
            service_root / "config" / "autonomy-gates-v3.json"
        )
        gitops_payload = _load_gitops_runtime_policy_payload()
        self.assertEqual(gitops_payload, canonical)

    def test_canonical_policy_includes_required_runtime_contract_keys(self) -> None:
        canonical = load_runtime_gate_policy(
            _service_root() / "config" / "autonomy-gates-v3.json"
        )
        self.assertEqual(required_key_errors(canonical), [])

    def test_runtime_policy_contract_assertion_fails_for_missing_required_key(
        self,
    ) -> None:
        canonical = load_runtime_gate_policy(
            _service_root() / "config" / "autonomy-gates-v3.json"
        )
        canonical.pop("promotion_require_stress_evidence", None)
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(canonical), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                assert_runtime_gate_policy_contract(str(policy_path))

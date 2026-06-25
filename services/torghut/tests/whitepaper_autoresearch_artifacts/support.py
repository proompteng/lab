from __future__ import annotations


from decimal import Decimal
from typing import Any
from unittest import TestCase
from unittest.mock import patch

import numpy as np

import app.trading.discovery.candidate_specs as candidate_specs_module
import app.trading.discovery.evidence_bundles as evidence_bundles_module
import app.trading.discovery.mlx_training_data as mlx_training_data_module
from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
    hypothesis_card_from_payload,
)
from app.trading.discovery.mlx_training_data import (
    MlxTrainingRow,
    build_mlx_training_rows,
    mlx_ranker_model_from_payload,
    rank_training_rows,
    train_mlx_ranker,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate


class _FakeTorchTensor:
    def __init__(self, value: Any) -> None:
        self._value = np.array(value, dtype=float)

    @property
    def T(self) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value.T)

    def __matmul__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value @ self._coerce(other))

    def __add__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value + self._coerce(other))

    def __radd__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._coerce(other) + self._value)

    def __sub__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value - self._coerce(other))

    def __rsub__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._coerce(other) - self._value)

    def __mul__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value * self._coerce(other))

    def __rmul__(self, other: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._coerce(other) * self._value)

    def mean(self) -> _FakeTorchTensor:
        return _FakeTorchTensor(self._value.mean())

    def item(self) -> float:
        return float(self._value.item())

    def tolist(self) -> list[float]:
        return list(self._value.tolist())

    @staticmethod
    def _coerce(value: Any) -> Any:
        if isinstance(value, _FakeTorchTensor):
            return value._value
        return value


class _FakeTorchCuda:
    @staticmethod
    def is_available() -> bool:
        return True


class _FakeTorchCpu:
    @staticmethod
    def is_available() -> bool:
        return False


class _FakeTorchModule:
    float32 = "float32"
    cuda = _FakeTorchCuda()

    @staticmethod
    def tensor(value: Any, **_: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(value)

    @staticmethod
    def zeros(value: Any, **_: Any) -> _FakeTorchTensor:
        return _FakeTorchTensor(np.zeros(value, dtype=float))


class _FakeTorchCpuModule(_FakeTorchModule):
    cuda = _FakeTorchCpu()


def _profile_ids_for_family(family_template_id: str) -> list[str]:
    return [
        f"{family_template_id}:profile-{index + 1}"
        for index in range(
            len(
                candidate_specs_module._execution_profiles_for_target(
                    family_template_id=family_template_id,
                    target_net_pnl_per_day=Decimal("500"),
                )
            )
        )
    ]


class _TestWhitepaperAutoresearchArtifactsBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "Any",
    "Decimal",
    "HYPOTHESIS_CARD_SCHEMA_VERSION",
    "HypothesisCard",
    "MlxTrainingRow",
    "TestCase",
    "_FakeTorchCpu",
    "_FakeTorchCpuModule",
    "_FakeTorchCuda",
    "_FakeTorchModule",
    "_FakeTorchTensor",
    "_TestWhitepaperAutoresearchArtifactsBase",
    "_profile_ids_for_family",
    "build_hypothesis_cards",
    "build_mlx_training_rows",
    "candidate_spec_from_payload",
    "candidate_specs_module",
    "compile_candidate_specs",
    "evidence_bundle_blockers",
    "evidence_bundle_from_frontier_candidate",
    "evidence_bundle_from_payload",
    "evidence_bundles_module",
    "hypothesis_card_from_payload",
    "mlx_ranker_model_from_payload",
    "mlx_training_data_module",
    "np",
    "optimize_portfolio_candidate",
    "patch",
    "rank_training_rows",
    "train_mlx_ranker",
)

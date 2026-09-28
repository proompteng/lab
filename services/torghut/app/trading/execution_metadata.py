"""Canonical execution metadata for trade decisions."""

from __future__ import annotations

import typing
from collections.abc import Mapping
from typing import cast

EXECUTION_METADATA_KEY = "execution"
_REMOVED_SIMPLE_LANE_METADATA_KEY = "simple_lane"


def execution_metadata(
    params: Mapping[str, typing.Any],
) -> Mapping[str, typing.Any] | None:
    raw_execution = params.get(EXECUTION_METADATA_KEY)
    if isinstance(raw_execution, Mapping):
        return cast(Mapping[str, typing.Any], raw_execution)
    return None


def mutable_execution_metadata(
    params: Mapping[str, typing.Any],
) -> dict[str, typing.Any]:
    metadata = execution_metadata(params)
    return dict(metadata) if metadata is not None else {}


def set_execution_metadata(
    params: dict[str, typing.Any],
    metadata: Mapping[str, typing.Any],
) -> None:
    params.pop(_REMOVED_SIMPLE_LANE_METADATA_KEY, None)
    params[EXECUTION_METADATA_KEY] = dict(metadata)


__all__ = [
    "EXECUTION_METADATA_KEY",
    "execution_metadata",
    "mutable_execution_metadata",
    "set_execution_metadata",
]

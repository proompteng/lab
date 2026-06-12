"""Canonical runtime-window proof API."""

from .schemas import PROOFS_SCHEMA_VERSION
from .service import build_proofs_payload

__all__ = ["PROOFS_SCHEMA_VERSION", "build_proofs_payload"]

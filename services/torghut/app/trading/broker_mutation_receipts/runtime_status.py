"""Operator-visible code wiring status for broker-mutation safety."""

from __future__ import annotations

from ..action_authority import BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION

# The durable receipt package is deliberately isolated from every broker runtime.
# These facts must change only in the PRs that wire and fault-prove those paths.
BROKER_MUTATION_RUNTIME_WIRED = False
BROKER_MUTATION_ENTRY_FENCING_PROVEN = False
BROKER_MUTATION_REDUCTION_FENCING_PROVEN = False
BROKER_MUTATION_RECOVERY_WORKER_WIRED = False


def build_broker_mutation_runtime_status() -> dict[str, object]:
    """Return current code wiring truth without adding status-path database load."""

    return {
        "schema_version": BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION,
        "runtime_wired": BROKER_MUTATION_RUNTIME_WIRED,
        "entry_fencing_proven": BROKER_MUTATION_ENTRY_FENCING_PROVEN,
        "reduction_fencing_proven": BROKER_MUTATION_REDUCTION_FENCING_PROVEN,
        "recovery_worker_wired": BROKER_MUTATION_RECOVERY_WORKER_WIRED,
        "recovery_degraded": True,
        "reason_codes": ["broker_mutation_receipts_unwired"],
    }


__all__ = [
    "BROKER_MUTATION_ENTRY_FENCING_PROVEN",
    "BROKER_MUTATION_RECOVERY_WORKER_WIRED",
    "BROKER_MUTATION_REDUCTION_FENCING_PROVEN",
    "BROKER_MUTATION_RUNTIME_WIRED",
    "build_broker_mutation_runtime_status",
]

"""Canonical, durable broker-mutation receipt contracts.

This package is intentionally not wired into broker runtimes yet. Public lifecycle
operations are exported only after their fencing and recovery races are proven.
"""

from .canonicalization import (
    BROKER_MUTATION_INTENT_SCHEMA_VERSION,
    build_broker_mutation_intent,
    canonicalize_broker_mutation_evidence,
    fingerprint_broker_endpoint,
)
from .types import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationOperation,
    BrokerMutationPurpose,
    BrokerMutationReceiptEventSnapshot,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRiskClass,
    BrokerMutationRoute,
    BrokerMutationRuntimeResult,
    BrokerMutationSettlementOutcome,
    BrokerMutationTarget,
    broker_mutation_runtime_result,
)
from .validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
)


__all__ = [
    "BROKER_MUTATION_INTENT_SCHEMA_VERSION",
    "BrokerMutationIntent",
    "BrokerMutationIntentRequest",
    "BrokerMutationOperation",
    "BrokerMutationPurpose",
    "BrokerMutationReceiptConflictError",
    "BrokerMutationReceiptError",
    "BrokerMutationReceiptEventSnapshot",
    "BrokerMutationReceiptFenceError",
    "BrokerMutationReceiptSnapshot",
    "BrokerMutationReceiptValidationError",
    "BrokerMutationRiskClass",
    "BrokerMutationRoute",
    "BrokerMutationRuntimeResult",
    "BrokerMutationSettlementOutcome",
    "BrokerMutationTarget",
    "broker_mutation_runtime_result",
    "build_broker_mutation_intent",
    "canonicalize_broker_mutation_evidence",
    "fingerprint_broker_endpoint",
]

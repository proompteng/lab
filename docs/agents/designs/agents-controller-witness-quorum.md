# Agents Controller Witness Quorum

Status: Current

The Agents platform owns the controller witness quorum emitted through `/api/agents/control-plane/status` and the
readiness fallback contract used by downstream domain services. This contract is generic platform evidence, not a
Jangar or Torghut domain receipt.

The quorum compares three independent witnesses:

- Kubernetes deployment availability for `agents-controllers`.
- AgentRun watch freshness for the served namespace.
- AgentRun ingestion self-report freshness from the active controller process.

Decisions:

- `allow`: the controller deployment is available and AgentRun ingestion self-report is current.
- `repair_only`: the controller deployment is available and the watch epoch is current, but the self-report is not fully
  current.
- `hold_material`: deployment, watch, or ingestion evidence is unavailable, stale, or degraded.
- `block`: reserved for contradictory evidence that proves the controller is unsafe to dispatch.

Domain consumers may read this quorum as input evidence, but they must add their own business-specific admission rules
outside the Agents service.

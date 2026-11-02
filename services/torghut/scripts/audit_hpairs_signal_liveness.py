from __future__ import annotations

from scripts.hpairs_signal_liveness_audit import (
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    DEFAULT_OBSERVED_STAGE,
    HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION,
    NEXT_ACTIONS,
    AuditExpectations,
    build_liveness_report,
    main,
    parse_args,
    stable_json,
)

__all__ = (
    "DEFAULT_HPAIRS_ACCOUNT_LABEL",
    "DEFAULT_HPAIRS_CANDIDATE_ID",
    "DEFAULT_HPAIRS_HYPOTHESIS_ID",
    "DEFAULT_HPAIRS_RUNTIME_STRATEGY",
    "DEFAULT_OBSERVED_STAGE",
    "HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION",
    "NEXT_ACTIONS",
    "AuditExpectations",
    "build_liveness_report",
    "main",
    "parse_args",
    "stable_json",
)

if __name__ == "__main__":
    raise SystemExit(main())

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python
"""Verify Torghut trading readiness from a `/trading/status` payload."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast
from urllib.request import urlopen

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_16 import *
from .part_02_paper_route_target_plan_summary import *
from .part_03_add_tigerbeetle_parity_check import *
from .part_04_evaluate_trading_readiness import *


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    status = (
        _load_json_object(args.status_file)
        if args.status_file is not None
        else _load_status_url(
            str(args.status_url), timeout_seconds=args.timeout_seconds
        )
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
    )
    paper_route_evidence = _load_optional_json_object(
        path=args.paper_route_evidence_file,
        url=args.paper_route_evidence_url,
        timeout_seconds=args.timeout_seconds,
    )
    runtime_ledger_proof_packet = _load_optional_json_object(
        path=args.runtime_ledger_proof_packet_file,
        url=args.runtime_ledger_proof_packet_url,
        timeout_seconds=args.timeout_seconds,
    )
    tigerbeetle_parity = _load_optional_json_object(
        path=args.tigerbeetle_parity_file,
        url=args.tigerbeetle_parity_url,
        timeout_seconds=args.timeout_seconds,
    )
    min_runtime_ledger_net_pnl = _decimal(args.min_runtime_ledger_net_pnl)
    if min_runtime_ledger_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-net-pnl must be decimal, got {args.min_runtime_ledger_net_pnl!r}"
        )
    min_runtime_ledger_daily_net_pnl = _decimal(args.min_runtime_ledger_daily_net_pnl)
    if min_runtime_ledger_daily_net_pnl is None:
        raise SystemExit(
            "--min-runtime-ledger-daily-net-pnl must be decimal, "
            f"got {args.min_runtime_ledger_daily_net_pnl!r}"
        )
    result = evaluate_trading_readiness(
        status,
        completion_status=completion_status,
        paper_route_evidence=paper_route_evidence,
        runtime_ledger_proof_packet=runtime_ledger_proof_packet,
        tigerbeetle_parity=tigerbeetle_parity,
        profile=str(args.profile),
        min_routeable_symbols=max(0, int(args.min_routeable_symbols)),
        min_decisions=max(0, int(args.min_decisions)),
        min_orders=max(0, int(args.min_orders)),
        min_runtime_ledger_net_pnl=min_runtime_ledger_net_pnl,
        min_runtime_ledger_trading_days=max(
            0, int(args.min_runtime_ledger_trading_days)
        ),
        min_runtime_ledger_daily_net_pnl=min_runtime_ledger_daily_net_pnl,
        require_market_open=not bool(args.allow_closed_session),
        require_quant_fresh=not bool(args.allow_informational_quant),
        require_paper_route_probe_candidate=bool(
            args.require_paper_route_probe_candidate
        ),
        require_paper_route_target_plan=bool(args.require_paper_route_target_plan),
        require_paper_route_import_ready=bool(args.require_paper_route_import_ready),
        require_runtime_ledger_profit_proof=bool(
            args.require_runtime_ledger_profit_proof
        ),
        require_runtime_ledger_proof_packet=bool(
            args.require_runtime_ledger_proof_packet
        ),
        require_tigerbeetle_parity=bool(args.require_tigerbeetle_parity),
        allow_paper_route_preopen_evidence_collection=bool(
            args.allow_paper_route_preopen_evidence_collection
        ),
    )
    result["evaluated_at"] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [name for name in globals() if not name.startswith("__")]

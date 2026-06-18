"""Command-line interface for runtime-ledger proof packet assembly."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from scripts.assemble_runtime_ledger_proof_packet_modules.common import (
    DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
    DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS,
    RUNTIME_LEDGER_PROOF_MODES,
    _decimal,
    _text,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.io_artifacts import (
    _apply_service_base_url_defaults,
    _attach_and_upload_artifact,
    _load_optional_json_object,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.packet_builder import (
    build_runtime_ledger_proof_packet,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--service-base-url",
        help="Base Torghut service URL used for any source endpoint without a more specific service base URL.",
    )
    parser.add_argument(
        "--status-service-base-url",
        help="Base Torghut live service URL used to fetch /trading/status.",
    )
    parser.add_argument(
        "--paper-route-service-base-url",
        help="Base Torghut paper/sim service URL used to fetch /trading/proofs.",
    )
    parser.add_argument(
        "--completion-service-base-url",
        help="Base Torghut live service URL used to fetch /trading/completion/doc29.",
    )
    parser.add_argument(
        "--status-file", type=Path, help="Path to a /trading/status JSON payload."
    )
    parser.add_argument(
        "--status-url", help="URL returning a /trading/status JSON payload."
    )
    parser.add_argument(
        "--paper-route-evidence-file",
        type=Path,
        help="Path to a /trading/proofs JSON payload.",
    )
    parser.add_argument(
        "--paper-route-evidence-url",
        help="URL returning a /trading/proofs JSON payload.",
    )
    parser.add_argument(
        "--runtime-window-import-file",
        type=Path,
        help="Path to renew_latest_empirical_promotion_jobs.py runtime_window_import JSON output.",
    )
    parser.add_argument(
        "--runtime-window-import-url",
        help="URL returning runtime-window import JSON output.",
    )
    parser.add_argument(
        "--hpairs-source-proof-census-file",
        type=Path,
        help="Path to a read-only audit_hpairs_source_proof_census.py JSON artifact.",
    )
    parser.add_argument(
        "--hpairs-source-proof-census-url",
        help="URL returning a read-only H-PAIRS source-proof census JSON artifact.",
    )
    parser.add_argument(
        "--completion-file",
        type=Path,
        help="Path to a /trading/completion/doc29 JSON payload.",
    )
    parser.add_argument(
        "--completion-url", help="URL returning /trading/completion/doc29 JSON."
    )
    parser.add_argument(
        "--proof-mode",
        choices=RUNTIME_LEDGER_PROOF_MODES,
        default=DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
        help=(
            "Proof packet mode. smoke/probation prove plumbing or bounded "
            "evidence collection only; authority is required for promotion."
        ),
    )
    parser.add_argument(
        "--min-runtime-ledger-net-pnl",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_net_pnl_after_costs),
        help="Minimum total runtime-ledger net strategy PnL after costs.",
    )
    parser.add_argument(
        "--min-runtime-ledger-daily-net-pnl",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_daily_net_pnl_after_costs),
        help="Minimum runtime-ledger net strategy PnL after costs per observed trading day.",
    )
    parser.add_argument(
        "--min-runtime-ledger-trading-days",
        type=int,
        default=DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_trading_days,
        help="Minimum observed runtime-ledger trading days.",
    )
    parser.add_argument(
        "--max-runtime-ledger-drawdown-pct-equity",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity),
        help="Maximum observed runtime-ledger drawdown as a fraction of equity.",
    )
    parser.add_argument(
        "--max-runtime-ledger-best-day-share",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_best_day_share),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one trading day.",
    )
    parser.add_argument(
        "--max-runtime-ledger-symbol-concentration-share",
        default=str(DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_symbol_concentration_share),
        help="Maximum share of post-cost runtime-ledger PnL attributable to one symbol.",
    )
    parser.add_argument("--generated-at", default=None)
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS,
        help=(
            "Timeout for service-backed status, paper-route, completion, and "
            "runtime-window import JSON reads."
        ),
    )
    parser.add_argument("--output-file", type=Path, default=None)
    parser.add_argument(
        "--artifact-prefix",
        default="",
        help=(
            "Optional object-store prefix for durable proof packet upload. "
            "Supports {run_id} from the runtime-window import payload and "
            "{generated_at} from the packet timestamp."
        ),
    )
    parser.add_argument(
        "--artifact-name",
        default="runtime-ledger-proof-packet.json",
        help="Object-store file name for --artifact-prefix uploads.",
    )
    parser.add_argument(
        "--require-artifact-upload",
        action="store_true",
        help=(
            "Fail closed unless an artifact prefix, object-store credentials, "
            "and a complete upload receipt are available."
        ),
    )
    parser.add_argument(
        "--allow-blocked-exit-zero",
        action="store_true",
        help=(
            "Exit 0 after writing a blocked/waiting packet. Required source "
            "schema errors still fail; degraded paper-route/completion service "
            "fetches are recorded as proof blockers so scheduled evidence "
            "collection still uploads an honest packet."
        ),
    )
    return parser


def _required_source_args(args: argparse.Namespace) -> None:
    if (args.status_file is None) == (not args.status_url):
        raise SystemExit("exactly_one_status_source_required")
    if (args.paper_route_evidence_file is None) == (not args.paper_route_evidence_url):
        raise SystemExit("exactly_one_paper_route_evidence_source_required")


def _source_kind(path: Path | None, url: str | None) -> str:
    if path is not None:
        return "file"
    if url:
        return "url"
    return "missing"


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    service_default_urls = _apply_service_base_url_defaults(args)
    _required_source_args(args)
    min_net_pnl = _decimal(args.min_runtime_ledger_net_pnl)
    if min_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-net-pnl must be decimal: {args.min_runtime_ledger_net_pnl!r}"
        )
    min_daily_net_pnl = _decimal(args.min_runtime_ledger_daily_net_pnl)
    if min_daily_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-daily-net-pnl must be decimal: {args.min_runtime_ledger_daily_net_pnl!r}"
        )
    max_drawdown_pct_equity = _decimal(args.max_runtime_ledger_drawdown_pct_equity)
    if max_drawdown_pct_equity is None:
        raise SystemExit(
            "--max-runtime-ledger-drawdown-pct-equity must be decimal: "
            f"{args.max_runtime_ledger_drawdown_pct_equity!r}"
        )
    max_best_day_share = _decimal(args.max_runtime_ledger_best_day_share)
    if max_best_day_share is None:
        raise SystemExit(
            "--max-runtime-ledger-best-day-share must be decimal: "
            f"{args.max_runtime_ledger_best_day_share!r}"
        )
    max_symbol_concentration_share = _decimal(
        args.max_runtime_ledger_symbol_concentration_share
    )
    if max_symbol_concentration_share is None:
        raise SystemExit(
            "--max-runtime-ledger-symbol-concentration-share must be decimal: "
            f"{args.max_runtime_ledger_symbol_concentration_share!r}"
        )
    status = _load_optional_json_object(
        path=args.status_file,
        url=args.status_url,
        timeout_seconds=args.timeout_seconds,
    )
    paper_route_evidence = _load_optional_json_object(
        path=args.paper_route_evidence_file,
        url=args.paper_route_evidence_url,
        timeout_seconds=args.timeout_seconds,
        unavailable_source_name="paper_route_evidence",
    )
    runtime_window_import = _load_optional_json_object(
        path=args.runtime_window_import_file,
        url=args.runtime_window_import_url,
        timeout_seconds=args.timeout_seconds,
    )
    hpairs_source_proof_census = _load_optional_json_object(
        path=args.hpairs_source_proof_census_file,
        url=args.hpairs_source_proof_census_url,
        timeout_seconds=args.timeout_seconds,
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
        unavailable_source_name="completion",
    )
    assert status is not None
    packet = build_runtime_ledger_proof_packet(
        status,
        proof_mode=args.proof_mode,
        paper_route_evidence=paper_route_evidence,
        runtime_window_import=runtime_window_import,
        hpairs_source_proof_census=hpairs_source_proof_census,
        completion_status=completion_status,
        min_runtime_ledger_net_pnl=min_net_pnl,
        min_runtime_ledger_daily_net_pnl=min_daily_net_pnl,
        min_runtime_ledger_trading_days=max(
            0, int(args.min_runtime_ledger_trading_days)
        ),
        max_runtime_ledger_drawdown_pct_equity=max_drawdown_pct_equity,
        max_runtime_ledger_best_day_share=max_best_day_share,
        max_runtime_ledger_symbol_concentration_share=max_symbol_concentration_share,
        generated_at=args.generated_at,
    )
    if service_default_urls:
        packet["assembly"] = {
            "service_base_url": args.service_base_url,
            "service_base_urls": {
                "status": args.status_service_base_url or args.service_base_url,
                "paper_route_evidence": (
                    args.paper_route_service_base_url or args.service_base_url
                ),
                "completion": args.completion_service_base_url or args.service_base_url,
            },
            "defaulted_urls": service_default_urls,
            "status_source": _source_kind(args.status_file, args.status_url),
            "paper_route_evidence_source": _source_kind(
                args.paper_route_evidence_file,
                args.paper_route_evidence_url,
            ),
            "runtime_window_import_source": _source_kind(
                args.runtime_window_import_file,
                args.runtime_window_import_url,
            ),
            "hpairs_source_proof_census_source": _source_kind(
                args.hpairs_source_proof_census_file,
                args.hpairs_source_proof_census_url,
            ),
            "completion_source": _source_kind(
                args.completion_file, args.completion_url
            ),
        }
    artifact_prefix = _text(args.artifact_prefix)
    encoded_body = (
        _attach_and_upload_artifact(
            packet,
            artifact_prefix=artifact_prefix,
            artifact_name=_text(
                args.artifact_name,
                "runtime-ledger-proof-packet.json",
            ),
            require_artifact_upload=bool(args.require_artifact_upload),
            runtime_window_import=runtime_window_import,
        )
        if artifact_prefix or args.require_artifact_upload
        else json.dumps(packet, indent=2, sort_keys=True).encode("utf-8")
    )
    if args.output_file is not None:
        args.output_file.parent.mkdir(parents=True, exist_ok=True)
        args.output_file.write_bytes(encoded_body + b"\n")
    print(encoded_body.decode("utf-8"))
    return 0 if packet["ok"] or args.allow_blocked_exit_zero else 1


__all__ = ("_parser", "_required_source_args", "_source_kind", "main")

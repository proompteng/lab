#!/usr/bin/env python3
"""Independently verify a promotion-grade point-in-time replay tape."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.trading.discovery.replay_tape import (
    default_manifest_path,
    load_replay_tape,
    verify_point_in_time_data_receipt,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tape", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--expected-content-sha256", default="")
    parser.add_argument("--expected-receipt-sha256", default="")
    parser.add_argument("--expected-input-row-set-sha256", default="")
    parser.add_argument("--expected-feature-matrix-sha256", default="")
    return parser.parse_args()


def _normalized_sha256(value: str) -> str:
    return str(value).strip().lower().removeprefix("sha256:")


def verify_replay_tape(
    *,
    tape_path: Path,
    manifest_path: Path | None = None,
    expected_content_sha256: str = "",
    expected_receipt_sha256: str = "",
    expected_input_row_set_sha256: str = "",
    expected_feature_matrix_sha256: str = "",
) -> dict[str, object]:
    resolved_manifest_path = manifest_path or default_manifest_path(tape_path)
    tape = load_replay_tape(tape_path, manifest_path=resolved_manifest_path)
    receipt = tape.manifest.point_in_time_receipt
    if receipt is None:
        raise ValueError("replay_tape_point_in_time_receipt_required")
    diagnostics = verify_point_in_time_data_receipt(
        receipt,
        rows=tape.rows,
        content_sha256=tape.manifest.content_sha256,
        feature_schema_hash=tape.manifest.feature_schema_hash,
        source_table_versions=tape.manifest.source_table_versions,
    )
    expected = {
        "content_sha256": expected_content_sha256,
        "receipt_sha256": expected_receipt_sha256,
        "input_row_set_sha256": expected_input_row_set_sha256,
        "feature_matrix_sha256": expected_feature_matrix_sha256,
    }
    actual = {
        "content_sha256": tape.manifest.content_sha256,
        "receipt_sha256": receipt.receipt_sha256,
        "input_row_set_sha256": receipt.input_row_set_sha256,
        "feature_matrix_sha256": receipt.feature_matrix_sha256,
    }
    mismatches = [
        field
        for field, expected_value in expected.items()
        if expected_value
        and _normalized_sha256(expected_value) != _normalized_sha256(actual[field])
    ]
    reason_codes = sorted(
        {
            *(str(reason) for reason in diagnostics.get("reason_codes", [])),
            *(f"expected_{field}_mismatch" for field in mismatches),
        }
    )
    return {
        "schema_version": "torghut.point-in-time-replay-tape-verification.v1",
        "status": "verified" if not reason_codes else "rejected",
        "reason_codes": reason_codes,
        "tape_path": str(tape_path),
        "manifest_path": str(resolved_manifest_path),
        "row_count": len(tape.rows),
        "observation_cutoff": receipt.observation_cutoff.isoformat(),
        **actual,
    }


def main() -> int:
    args = _parse_args()
    result = verify_replay_tape(
        tape_path=args.tape.resolve(),
        manifest_path=args.manifest.resolve() if args.manifest else None,
        expected_content_sha256=str(args.expected_content_sha256),
        expected_receipt_sha256=str(args.expected_receipt_sha256),
        expected_input_row_set_sha256=str(args.expected_input_row_set_sha256),
        expected_feature_matrix_sha256=str(args.expected_feature_matrix_sha256),
    )
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())

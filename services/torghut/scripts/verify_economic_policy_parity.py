#!/usr/bin/env python3
"""Emit one stage's controlled pre-broker fixture for cross-stage comparison."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    os.environ.setdefault("LOG_LEVEL", "WARNING")
    from app.trading.economic_policy import (
        DEFAULT_ECONOMIC_POLICY_PATH,
        load_pinned_economic_policy,
    )
    from app.trading.economic_policy_parity import (
        ECONOMIC_POLICY_PARITY_SCHEMA_VERSION,
        ECONOMIC_POLICY_STAGES,
        build_economic_policy_fixture_result,
    )

    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=ECONOMIC_POLICY_STAGES, required=True)
    parser.add_argument(
        "--policy",
        type=Path,
        default=Path(
            os.environ.get(
                "TRADING_ECONOMIC_POLICY_PATH", str(DEFAULT_ECONOMIC_POLICY_PATH)
            )
        ),
    )
    parser.add_argument(
        "--expected-digest",
        default=os.environ.get("TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST"),
    )
    args = parser.parse_args()
    policy = load_pinned_economic_policy(
        args.policy,
        expected_digest=args.expected_digest,
    )
    fixture = build_economic_policy_fixture_result(policy)
    report = {
        "schema_version": ECONOMIC_POLICY_PARITY_SCHEMA_VERSION,
        "fixture_id": "aapl-sell-10-v1",
        "stage": args.stage,
        "policy_id": policy.policy_id,
        **fixture,
    }
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if fixture["approved"] is True else 1


if __name__ == "__main__":
    raise SystemExit(main())

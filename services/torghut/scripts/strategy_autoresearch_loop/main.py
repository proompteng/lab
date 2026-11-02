#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import json


from .shared_context import (
    _parse_args,
)
from .run_strategy_autoresearch_loop import run_strategy_autoresearch_loop


def main() -> int:
    args = _parse_args()
    payload = run_strategy_autoresearch_loop(args)
    if args.json_output is not None:
        args.json_output.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ("main",)

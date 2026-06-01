#!/usr/bin/env python3
"""Probe optional Torghut quant GPU research backends."""

from __future__ import annotations

import argparse
import json

from app.trading.discovery.gpu_backends import (
    GPU_RESEARCH_BACKENDS,
    probe_gpu_research_backend,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe Torghut optional quant GPU research backends.",
    )
    parser.add_argument("--backend", action="append", choices=GPU_RESEARCH_BACKENDS)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    backends = tuple(args.backend or GPU_RESEARCH_BACKENDS)
    payload = [probe_gpu_research_backend(item).to_payload() for item in backends]
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compile recent whitepaper seed claims into hypothesis cards."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    compile_sources_to_hypothesis_cards,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile whitepaper research sources into hypothesis cards."
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed-recent-whitepapers", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    sources = RECENT_WHITEPAPER_SEEDS if args.seed_recent_whitepapers else ()
    cards = compile_sources_to_hypothesis_cards(sources)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "\n".join(json.dumps(card.to_payload(), sort_keys=True) for card in cards)
        + ("\n" if cards else ""),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {"status": "ok", "count": len(cards), "output": str(args.output)},
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

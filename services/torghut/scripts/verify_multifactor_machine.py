from __future__ import annotations

from collections.abc import Sequence

from scripts.verify_trading_loop_status import main as verify_trading_loop_status_main


def main(argv: Sequence[str] | None = None) -> int:
    """Fail unless the generic multifactor trading machine has hard proof."""

    return verify_trading_loop_status_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())

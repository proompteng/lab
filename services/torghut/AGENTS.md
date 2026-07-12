# Torghut Service Guide

- Use Python 3.11–3.12.
- Run focused tests first and broaden validation in proportion to the change.
- Before claiming type checks pass, run every required profile:
  - `uv sync --frozen --extra dev`
  - `uv run --frozen pyright --project pyrightconfig.json`
  - `uv run --frozen pyright --project pyrightconfig.alpha.json`
  - `uv run --frozen pyright --project pyrightconfig.scripts.json`

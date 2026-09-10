# alchimie

Dagster code location for data assets and jobs under `apps/alchimie`.

The active code location is `alchimie.definitions`, with source modules under `alchimie/` and tests under
`alchimie_tests/`.

## Requirements

- Python `3.9` through `3.12`
- Dagster `1.11.11`

## Local development

```bash
cd apps/alchimie
uv venv .venv
source .venv/bin/activate
uv pip install -e ".[dev]"
dagster dev
```

Dagster defaults to `http://localhost:3000`.

## Tests

```bash
cd apps/alchimie
pytest alchimie_tests
```

## Project layout

- `alchimie/assets.py`: Dagster assets
- `alchimie/jobs.py`: job definitions
- `alchimie/definitions.py`: Dagster code location entrypoint
- `docker-compose.yml`: local container workflow
- `Dockerfile`: container image build for the code location

## Notes

- Python dependencies are declared in both `pyproject.toml` and `setup.py` for the current packaging flow.
- The package metadata still carries a placeholder project description; update that when the domain scope is clearer.

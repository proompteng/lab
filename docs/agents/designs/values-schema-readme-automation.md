# Values Schema and README Automation

Status: Draft (2026-02-05)

## Purpose
Keep `charts/agents/README.md` and `charts/agents/values.schema.json` in lock-step with
`charts/agents/values.yaml` by introducing deterministic generation and CI drift checks.

## Current State
- `charts/agents/README.md` is maintained manually and does not contain `helm-docs` markers.
- `charts/agents/values.schema.json` is maintained manually.
- No script currently regenerates either artifact.
- CI validates CRDs and helm rendering via `scripts/agents/validate-agents.sh`, but it does not check README/schema
  drift.

## Design
- README generation: adopt `helm-docs` and add the standard `helm-docs` markers to
  `charts/agents/README.md` so only the values table is regenerated.
- Schema generation: add a small generator that infers schema from `values.yaml` and supports explicit constraints
  via inline `@schema` comments.
- CI drift detection: add a validation script that regenerates README and schema in a temp dir and fails if the
  output differs.

## Proposed Repository Changes
- Add `scripts/agents/generate-helm-docs.sh` to regenerate README and `values.schema.json`.
- Add `scripts/agents/validate-helm-docs.sh` to diff generated outputs against the repo.
- Add a CI job that runs `scripts/agents/validate-helm-docs.sh` on chart changes.

## Schema Constraints
Some constraints cannot be inferred from YAML alone. Encode them via inline comments in `values.yaml`:
- Enums for fields like service type, pull policy, or logging level.
- Ranges for TTLs, retry counts, and rate limits.
- Regex patterns for image tags or repository names.

## Rollout Plan
1. Add `helm-docs` markers to `charts/agents/README.md`.
2. Implement the generator script and commit generated README/schema.
3. Add CI validation and enforce drift checks on chart changes.

## Acceptance Criteria
- Running the generator script updates README and `values.schema.json` deterministically.
- CI fails when README/schema drift from `values.yaml`.
- Contributors have a single documented command to refresh outputs.

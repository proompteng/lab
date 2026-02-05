# Values Schema + README Automation Design

Status: Draft (2026-02-04)

## Problem
The Agents Helm chart documentation and validation metadata are manually maintained. `charts/agents/README.md` and
`charts/agents/values.schema.json` drift from `charts/agents/values.yaml`, which slows reviews and leaves gaps in
artifact hub validation. We need a deterministic, repeatable way to generate both files and keep them in sync.

## Goals
- Generate `charts/agents/README.md` from `charts/agents/values.yaml` on demand.
- Generate `charts/agents/values.schema.json` from `charts/agents/values.yaml` on demand.
- Preserve explicit schema constraints (regex, enums, min/max, oneOf) where needed.
- Provide a CI check that fails on drift.
- Keep local workflows simple and self-documenting.

## Non-Goals
- Changing values structure or chart behavior.
- Replacing Helm lint or CRD validation checks.
- Auto-updating values comments beyond what the generator requires.

## Current State
- `values.yaml`, `values.schema.json`, and `README.md` are all edited manually.
- Schema coverage expectations are documented in `docs/agents/agents-helm-chart-implementation.md`.
- Drift is only caught during review or after a failed release.

## Proposed Tooling
Use two generators, both invoked via a single repo script:

1) **README generator**
   - Use `helm-docs` to render `charts/agents/README.md`.
   - Source of truth: `charts/agents/values.yaml` comments and chart metadata.
   - Keep a template header in `charts/agents/README.md` with the `helm-docs` markers so the generator
     only overwrites the generated sections.

2) **Values schema generator**
   - Use a schema generator that reads `values.yaml` and respects inline schema hints.
   - Default schema inference comes from the YAML shape; explicit constraints are attached via
     inline annotations (example: `# @schema enum: ["ClusterIP", "LoadBalancer"]`).
   - Generated output replaces `charts/agents/values.schema.json` entirely.

## Repository Changes
Add a dedicated script that runs both generators and ensures consistent output:

- `scripts/agents/generate-helm-docs.sh`
  - Runs `helm-docs` for README generation.
  - Runs the schema generator for `values.schema.json`.
  - Fails if tools are missing or versions drift.

- `scripts/agents/validate-helm-docs.sh`
  - Runs the generation script in a temp dir.
  - Diffs `charts/agents/README.md` and `charts/agents/values.schema.json` against repo output.
  - Exits non-zero on drift for CI use.

## Workflow
- Local change to `charts/agents/values.yaml`:
  1. Update `values.yaml` and comments.
  2. Run `scripts/agents/generate-helm-docs.sh`.
  3. Review the regenerated README and schema in the same PR.

- CI:
  - Add a job that runs `scripts/agents/validate-helm-docs.sh`.
  - Failure indicates drift between `values.yaml`, `README.md`, and `values.schema.json`.

## Handling Explicit Schema Constraints
Some constraints cannot be inferred from YAML structure:
- Enums (service types, pull policies)
- Regex patterns (image tag format)
- Ranges (timeouts, retry counts)
- oneOf / anyOf structures

These must live in `values.yaml` comments using the schema hint syntax supported by the generator, so the
schema remains derived rather than hand-edited.

## Risks and Mitigations
- **Risk:** Generator output churn in large sections of README.
  - **Mitigation:** Keep the template stable, only regenerate when values change.
- **Risk:** Schema hints lost or malformed.
  - **Mitigation:** CI drift check plus review for `values.yaml` comment changes.
- **Risk:** Tool version mismatch across developer machines.
  - **Mitigation:** Pin versions via `mise` and document in the script header.

## Acceptance Criteria
- Running the generator script updates both `charts/agents/README.md` and `charts/agents/values.schema.json`.
- A CI job fails when the generated outputs differ from committed files.
- Explicit schema constraints are defined in `values.yaml` comments and appear in the generated schema.
- Contributors have a single documented command to refresh outputs.

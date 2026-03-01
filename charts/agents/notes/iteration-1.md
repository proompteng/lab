## agents chart checksum rollout iteration 1

- Added deterministic rollout checksum annotations for `Deployment/agents` and `Deployment/agents-controllers` via a new `rolloutChecksums` value.
- Added opt-in schema and validation guardrails in `charts/agents/values.schema.json` and `charts/agents/templates/validation.yaml`.
- Documented source-of-truth and operator workflow in:
  - `charts/agents/README.md`
  - `docs/agents/designs/chart-config-checksum-rollouts.md`
- Created merged pod template annotations via helper `agents.rolloutChecksumAnnotations` in `charts/agents/templates/_helpers.tpl`.
- Kept behavior safe for GitOps-managed external Secret/ConfigMap inputs by requiring explicit checksums when chart-managed DB secret is not enabled.

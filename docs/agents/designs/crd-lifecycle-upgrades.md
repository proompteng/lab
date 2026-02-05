# CRD Lifecycle Upgrades

Status: Current (2026-02-05)

## Purpose
Define the lifecycle and upgrade flow for Agents CRDs, including generation, validation, packaging, rollout,
compatibility rules, and CI enforcement. This design codifies the existing build and release workflow into a
production-ready checklist.

## Current State
- Source of truth: Agents CRDs live in `charts/agents/crds/` and are installed by Helm (`includeCRDs: true` in
  `argocd/applications/agents/kustomization.yaml`).
- Generation: Agent primitives are generated from Go types (`go generate services/jangar/api/agents`) and stamped
  with `controller-gen` annotations (currently `v0.20.0`). Supporting primitives are static YAML in the chart.
- Validation: `scripts/agents/validate-agents.sh` runs `go generate`, validates CRD schemas and examples with
  `kubeconform`, enforces a 256 KB size limit, and checks chart renderability.
- Runtime checks: `services/jangar/src/server/agents-controller.ts` verifies required CRDs at startup by running
  `kubectl get <resource> -n <namespace>` and fails fast if they are missing or unauthorized. The required set
  expands when `JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED=true`.
- Cluster: The agents namespace currently has CRDs for Agents, Orchestration, Tools, Signals, Budgets, Approval
  Policies, SecretBindings, Workspaces, Schedules, Artifacts, and VersionControlProviders. The ArgoCD app is
  managing CRDs with ServerSideApply and is currently reporting some OutOfSync resources.

## Design Principles
- CRDs are installed by Helm, not at runtime.
- Controller behavior and CRD schema must evolve together in a single change.
- Single-version CRDs (`v1alpha1`) remain the default until conversion webhooks are required.
- All CRDs expose `status` subresources, conditions, and printer columns for operator visibility.
- CI must validate schemas, examples, and size limits for every CRD change.

## Lifecycle Overview
### Authoring
- Update Go types under `services/jangar/api/agents/v1alpha1` for agent primitives.
- Update static YAML under `charts/agents/crds/` for supporting primitives.
- Update the controller logic in `services/jangar/src/server` in the same change set.

### Generation
- Run `go generate services/jangar/api/agents` to refresh CRDs and deepcopy outputs.
- Use `scripts/agents/patch-crds.py` to strip `x-kubernetes-preserve-unknown-fields: false` from CRDs when needed.
- Commit regenerated CRDs to `charts/agents/crds/`.

### Validation
- Run `scripts/agents/validate-agents.sh` to enforce:
  - Helm renderability for dev/local/ci/prod values files.
  - Example manifests compatibility with installed CRD versions.
  - Schema size limits (<= 256 KB per CRD).
  - CRD structural validation with `kubeconform`.

### Packaging
- Keep `Chart.yaml` annotations in sync with the CRD inventory for Artifact Hub.
- Update `charts/agents/examples` when new CRDs or required fields are introduced.

### Deployment
- Use Helm (via ArgoCD) to install CRDs before controller Deployments.
- Ensure the controller image and chart version are upgraded together.

## Compatibility Rules
- Additive changes only in `v1alpha1` (new optional fields, new status fields).
- Do not remove or rename fields without a deprecation and migration plan.
- Breaking schema changes require a new version and a conversion webhook.

## Rollback Strategy
- Roll back CRDs and controller together.
- Avoid introducing fields that older controllers cannot parse.

## Acceptance Criteria
- Regenerated CRDs match repository state after `go generate`.
- CI validation passes (`scripts/agents/validate-agents.sh`).
- Jangar reports missing CRDs clearly on startup.

## Open Questions
- When to introduce a formal `v1beta1` timeline and conversion webhook strategy.
- Whether to add automated compatibility checks against previous CRD versions in CI.

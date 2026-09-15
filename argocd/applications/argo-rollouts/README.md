# Argo Rollouts

This application installs the Argo Rollouts controller and CRDs for cluster-wide analysis and rollout control.

Phase 1 usage in this repo:

- managed as a **platform** app from `argocd/applicationsets/platform.yaml`
- dashboard disabled
- traffic-router integrations disabled
- controller metrics enabled
- analysis Jobs pinned to namespace `torghut` so Torghut simulation `AnalysisRun` templates execute with namespace-local RBAC and secrets

Torghut historical simulations continue to use Argo Workflows as the orchestrator. Argo Rollouts is introduced here as the
execution and status controller for simulation `AnalysisRun` gates.

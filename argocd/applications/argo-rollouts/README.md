# Argo Rollouts

This application installs the Argo Rollouts controller and CRDs for cluster-wide analysis and rollout control.

Chart 2.43.12 installs Rollouts 1.10.2. Validate the rendered CRDs with the controller update, then run a bounded
AnalysisRun against an existing read-only service check before accepting the upgrade.

Phase 1 usage in this repo:

- managed as a **platform** app from `argocd/applicationsets/platform.yaml`
- dashboard disabled
- traffic-router integrations disabled
- controller metrics enabled
- analysis Jobs run in their AnalysisRun's namespace, preserving Torghut simulation RBAC and secrets while allowing
  Kargo smoke checks in each application's release namespace

Torghut historical simulations continue to use Argo Workflows as the orchestrator. Argo Rollouts is introduced here as the
execution and status controller for simulation `AnalysisRun` gates.

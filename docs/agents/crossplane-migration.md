# Crossplane Removal (No Migration Required)

Status: Current (2026-01-19)

Crossplane-based Agents XRDs are not used and must be removed. There is no migration path because
no live Crossplane claims should exist. The only requirement is to disable Crossplane and delete
its XRDs so the native `agents.proompteng.ai/v1alpha1` CRDs can own the kinds.

## Required actions
1) **Disable Crossplane in GitOps**
   - Remove/disable any GitOps apps or ApplicationSet entries that install Crossplane.
2) **Delete Crossplane packages and XRDs**
   ```bash
   kubectl delete configurations.pkg.crossplane.io --all || true
   kubectl delete providers.pkg.crossplane.io --all || true
   kubectl delete compositions.apiextensions.crossplane.io --all || true
   kubectl delete xrd --all || true
   ```
3) **Remove Crossplane namespaces** (if present)
   ```bash
   kubectl delete namespace crossplane crossplane-system || true
   ```
4) **Verify Crossplane is gone**
   ```bash
   kubectl get crds | rg -i 'crossplane|xrd|xagent' || true
   kubectl get ns | rg -i 'crossplane' || true
   ```
5) **Install the native Agents chart**
   ```bash
   helm upgrade --install agents charts/agents -n agents --create-namespace
   ```

## Notes
- If any Crossplane claims are found, delete them before installing native CRDs. There is no
  supported conversion or migration because Crossplane was never used for production Agents.
- Native CRDs must be the only definitions for Agent, AgentRun, and AgentProvider kinds.

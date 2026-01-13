# Runbooks (Agents)

Status: Draft (2026-01-13)

## Install
1. `helm install agents charts/agents -n agents --create-namespace`
2. Verify CRDs: `kubectl get crd | rg agents.proompteng.ai`
3. Verify Jangar: `kubectl -n agents get deploy,svc`

## Upgrade
1. `helm upgrade agents charts/agents -n agents`
2. Confirm rollout: `kubectl -n agents rollout status deploy/agents`

## Rollback
1. `helm rollback agents <REV> -n agents`
2. Verify status and re-run smoke test.

## Stuck AgentRun
- Check status/conditions: `kubectl -n agents get agentrun <name> -o yaml`
- If runtimeRef exists, check runtime object (job/workflow).
- If no runtimeRef, inspect Jangar logs for submission errors.

## Failed Integration Sync
- Inspect ImplementationSource status.
- Check credentials secret exists and is valid.
- Temporarily disable webhook and use polling.

## Memory Outage
- Check Memory status and connection secret.
- Failover to alternative Memory (set default).
- Re-run failed AgentRuns.

## CRD Missing
- Reinstall chart or apply CRD YAMLs directly.
- Verify `kubectl api-resources | rg agents`.
